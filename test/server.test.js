"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:net");
const { mkdtemp, mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomBytes, scryptSync } = require("node:crypto");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");

async function unusedPort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("admin, menu, WhatsApp setup and order inbox work end to end", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dastarkhwan-test-"));
  const dataDirectory = path.join(directory, "data");
  await mkdir(dataDirectory);
  const password = "test-only-admin-password";
  const salt = randomBytes(16).toString("base64url");
  await writeFile(path.join(dataDirectory, "admin.json"), JSON.stringify({
    salt,
    hash: scryptSync(password, salt, 64).toString("base64url")
  }));
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDirectory },
    stdio: "ignore"
  });
  let cookie = "";
  let csrfToken = "";
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    await rm(directory, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Test server exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${base}/api/menu`);
      ready = response.ok;
      if (ready) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(ready, true, "server should start");

  const privateOrders = await fetch(`${base}/api/admin/orders`);
  assert.equal(privateOrders.status, 401);
  assert.equal((await fetch(`${base}/server.js`)).status, 404);
  assert.equal((await fetch(`${base}/data/state.json`)).status, 404);
  for (const icon of ["app-icon.png", "app-icon-maskable.png"]) {
    const response = await fetch(`${base}/${icon}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^image\/png/);
  }

  const wrongLogin = await fetch(`${base}/api/admin/login`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "wrong-password" })
  });
  assert.equal(wrongLogin.status, 401);

  const login = await fetch(`${base}/api/admin/login`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ password })
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];
  csrfToken = (await login.json()).csrfToken;
  const adminHeaders = {
    Cookie: cookie,
    Origin: base,
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken
  };

  const invalidCsrf = await fetch(`${base}/api/admin/settings`, {
    method: "PUT",
    headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ restaurantName: "Dastarkhwan", whatsappNumber: "" })
  });
  assert.equal(invalidCsrf.status, 403);

  const settings = await fetch(`${base}/api/admin/settings`, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({ restaurantName: "Demo Kitchen", whatsappNumber: "+923001234567" })
  });
  assert.equal(settings.status, 200);

  const uploadResponse = await fetch(`${base}/api/admin/uploads`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl5Z6cAAAAASUVORK5CYII="
    })
  });
  assert.equal(uploadResponse.status, 201);
  const { image } = await uploadResponse.json();
  assert.equal((await fetch(`${base}${image}`)).status, 200);

  const menu = await fetch(`${base}/api/admin/menu`, { headers: { Cookie: cookie } });
  const editableItems = (await menu.json()).menu;
  const chickenKarahi = editableItems.find((item) => item.id === "chicken-karahi");
  const updateMenu = await fetch(`${base}/api/admin/menu/chicken-karahi`, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({ ...chickenKarahi, price: 1500 })
  });
  assert.equal(updateMenu.status, 200);

  const addMenu = await fetch(`${base}/api/admin/menu`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      name: "Test Dish", urdu: "", category: "Test", price: 500, image,
      imageAlt: "A test dish", imagePosition: "center", badge: "", size: "1 portion",
      description: "Test description", detail: "More test details", popular: false, enabled: false
    })
  });
  assert.equal(addMenu.status, 201);
  const publicMenu = await fetch(`${base}/api/menu`);
  const publicItems = (await publicMenu.json()).menu;
  assert.equal(publicItems.some((item) => item.name === "Test Dish"), false);
  assert.equal(publicItems.find((item) => item.id === chickenKarahi.id).price, 1500);

  const invalidOrder = await fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ customerName: "Test", phone: "123", address: "Test address", items: [{ id: chickenKarahi.id, quantity: 1 }] })
  });
  assert.equal(invalidOrder.status, 400);

  const orderResponse = await fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({
      customerName: "Test Customer",
      phone: "0300 123 4567",
      address: "1 Test Street",
      notes: "",
      items: [{ id: chickenKarahi.id, quantity: 2, unitPrice: 1 }]
    })
  });
  assert.equal(orderResponse.status, 201);
  const orderResult = await orderResponse.json();
  assert.equal(orderResult.order.total, 3000);
  assert.equal(orderResult.whatsappNumber, "+923001234567");

  const savedOrders = await fetch(`${base}/api/admin/orders`, { headers: { Cookie: cookie } });
  const order = (await savedOrders.json()).orders[0];
  assert.equal(order.phone, "03001234567");
  assert.equal(order.total, 3000);

  const updateOrder = await fetch(`${base}/api/admin/orders/${order.id}`, {
    method: "PATCH",
    headers: adminHeaders,
    body: JSON.stringify({ status: "confirmed" })
  });
  assert.equal(updateOrder.status, 200);
  assert.equal((await updateOrder.json()).order.status, "confirmed");

  const deleteOrder = await fetch(`${base}/api/admin/orders/${order.id}`, {
    method: "DELETE",
    headers: adminHeaders
  });
  assert.equal(deleteOrder.status, 200);
  assert.deepEqual((await (await fetch(`${base}/api/admin/orders`, { headers: { Cookie: cookie } })).json()).orders, []);

  const storedState = JSON.parse(await readFile(path.join(dataDirectory, "state.json"), "utf8"));
  assert.equal(storedState.menu.find((item) => item.id === chickenKarahi.id).price, 1500);
  assert.equal(storedState.settings.restaurantName, "Demo Kitchen");
});
