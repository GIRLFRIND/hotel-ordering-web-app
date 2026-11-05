"use strict";

const http = require("node:http");
const { createReadStream, promises: fs } = require("node:fs");
const path = require("node:path");
const { randomBytes, randomUUID, scryptSync, timingSafeEqual } = require("node:crypto");
const seedMenu = require("./menu-data.js");

const root = path.resolve(__dirname);
const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(root, "data"));
const uploadsDirectory = path.join(dataDirectory, "uploads");
const stateFile = path.join(dataDirectory, "state.json");
const adminFile = path.join(dataDirectory, "admin.json");
const port = Number(process.env.PORT) || 4173;
const sessionLifetime = 8 * 60 * 60 * 1000;
const maximumUploadBytes = 2 * 1024 * 1024;
const sessions = new Map();
const loginAttempts = new Map();
const orderAttempts = new Map();
let state;
let mutationQueue = Promise.resolve();

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp"
};
const orderStatuses = ["new", "confirmed", "preparing", "ready", "completed", "cancelled"];
const publicFiles = new Set([
  "index.html", "admin.html", "privacy.html", "style.css", "admin.css", "app.js", "admin.js",
  "menu-data.js", "manifest.webmanifest", "service-worker.js", "app-icon.png",
  "app-icon-maskable.png", "hero-food.svg"
]);

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(JSON.stringify(value));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || "").split(";").flatMap((part) => {
    const index = part.indexOf("=");
    if (index < 0) return [];
    return [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]];
  }));
}

function requestIsSecure(request) {
  return request.socket.encrypted || request.headers["x-forwarded-proto"] === "https";
}

function cookieHeader(request, token, lifetime = sessionLifetime) {
  return [
    `dk_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(lifetime / 1000))}`,
    ...(requestIsSecure(request) ? ["Secure"] : [])
  ].join("; ");
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const protocol = requestIsSecure(request) ? "https:" : "http:";
    return new URL(origin).origin === `${protocol}//${request.headers.host}`;
  } catch {
    return false;
  }
}

async function readJson(request, maximumBytes = 64 * 1024) {
  const contentType = (request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    const error = new Error("Send this request as JSON.");
    error.status = 415;
    throw error;
  }
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (declaredLength > maximumBytes) {
    const error = new Error("The request is too large.");
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximumBytes) {
      const error = new Error("The request is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Expected an object.");
    return value;
  } catch {
    const error = new Error("The request contains invalid JSON.");
    error.status = 400;
    throw error;
  }
}

async function loadAdminCredentials() {
  try {
    return JSON.parse(await fs.readFile(adminFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function verifyPassword(password, credentials) {
  if (typeof password !== "string" || !credentials || typeof credentials.salt !== "string" || typeof credentials.hash !== "string") return false;
  const actual = scryptSync(password, credentials.salt, 64);
  const expected = Buffer.from(credentials.hash, "base64url");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function getSession(request) {
  const token = parseCookies(request).dk_session;
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function requireSession(request, response) {
  const session = getSession(request);
  if (!session) {
    sendError(response, 401, "Please sign in again.");
    return null;
  }
  return session;
}

function requireCsrf(request, response, session) {
  if (!sameOrigin(request)) {
    sendError(response, 403, "This request must come from this site.");
    return false;
  }
  if (request.headers["x-csrf-token"] !== session.csrfToken) {
    sendError(response, 403, "The session expired. Refresh the page and sign in again.");
    return false;
  }
  return true;
}

function checkRateLimit(limits, key, maximum, windowMs) {
  const now = Date.now();
  const recent = (limits.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
  if (recent.length >= maximum) {
    limits.set(key, recent);
    return false;
  }
  recent.push(now);
  limits.set(key, recent);
  return true;
}

function cleanText(value, label, maximum, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return "";
  if (typeof value !== "string") throw Object.assign(new Error(`${label} is required.`), { status: 400 });
  const clean = value.trim();
  if (!clean || clean.length > maximum) throw Object.assign(new Error(`${label} must be between 1 and ${maximum} characters.`), { status: 400 });
  return clean;
}

function validateMenuItem(input, existingId = "") {
  const id = existingId || `item-${randomUUID().slice(0, 12)}`;
  if (input.id && existingId && input.id !== existingId) {
    throw Object.assign(new Error("Menu item IDs cannot be changed."), { status: 400 });
  }
  const price = Number(input.price);
  if (!Number.isSafeInteger(price) || price < 1 || price > 10000000) {
    throw Object.assign(new Error("Enter a whole-number price between 1 and 10,000,000 PKR."), { status: 400 });
  }
  if (typeof input.enabled !== "boolean" || typeof input.popular !== "boolean") {
    throw Object.assign(new Error("Choose whether the item is available and popular."), { status: 400 });
  }
  const image = cleanText(input.image, "Photo", 180);
  if (!/^\/uploads\/[a-f0-9-]+\.(?:jpe?g|png|webp)$/.test(image)
      && !/^images\/[a-z0-9/-]+\.(?:jpe?g|png|webp)$/.test(image)) {
    throw Object.assign(new Error("Choose an uploaded menu photo."), { status: 400 });
  }
  const imagePosition = cleanText(input.imagePosition || "center", "Photo position", 40);
  if (!/^(?:center|left|right|top|bottom)(?:\s+(?:center|left|right|top|bottom|(?:100|[1-9]?\d)%))?$/i.test(imagePosition)) {
    throw Object.assign(new Error("Choose a valid photo position."), { status: 400 });
  }
  return {
    id,
    name: cleanText(input.name, "Name", 80),
    urdu: cleanText(input.urdu || "", "Urdu name", 80, { optional: true }),
    category: cleanText(input.category, "Category", 40),
    price,
    image,
    imageAlt: cleanText(input.imageAlt || input.name, "Photo description", 140),
    imagePosition,
    badge: cleanText(input.badge || "", "Badge", 36, { optional: true }),
    size: cleanText(input.size, "Serving size", 60),
    description: cleanText(input.description, "Short description", 200),
    detail: cleanText(input.detail || input.description, "Full description", 600),
    popular: input.popular,
    enabled: input.enabled
  };
}

async function saveState(nextState) {
  const temporaryPath = `${stateFile}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(nextState, null, 2), { mode: 0o600 });
  await fs.rename(temporaryPath, stateFile);
}

function updateState(mutator) {
  const operation = mutationQueue.then(async () => {
    const nextState = structuredClone(state);
    const result = await mutator(nextState);
    await saveState(nextState);
    state = nextState;
    return result;
  });
  mutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function initialize() {
  await fs.mkdir(uploadsDirectory, { recursive: true });
  try {
    const saved = JSON.parse(await fs.readFile(stateFile, "utf8"));
    if (!saved || !Array.isArray(saved.menu) || !Array.isArray(saved.orders) || !saved.settings) {
      throw new Error(`Stored application state at ${stateFile} is invalid.`);
    }
    state = saved;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = {
      menu: structuredClone(seedMenu).map((item) => ({ ...item, enabled: true })),
      orders: [],
      settings: { restaurantName: "Dastarkhwan", whatsappNumber: "" }
    };
    await saveState(state);
  }
  if (!await loadAdminCredentials()) {
    const password = process.env.ADMIN_PASSWORD;
    if (password !== undefined) {
      if (password.length < 12 || password.length > 200) {
        throw new Error("ADMIN_PASSWORD must be between 12 and 200 characters.");
      }
      const salt = randomBytes(16).toString("base64url");
      const hash = scryptSync(password, salt, 64).toString("base64url");
      await fs.writeFile(adminFile, JSON.stringify({ salt, hash }), { flag: "wx", mode: 0o600 });
      console.log("Admin password initialized from the ADMIN_PASSWORD environment variable.");
    } else {
      console.warn("Admin is not configured. Run `npm run setup-admin` or set ADMIN_PASSWORD before using the admin dashboard.");
    }
  }
}

function formatPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 18) {
    throw Object.assign(new Error("Enter a valid phone number."), { status: 400 });
  }
  return digits;
}

function validateOrder(input) {
  const name = cleanText(input.customerName, "Name", 80);
  const phone = formatPhone(cleanText(input.phone, "Phone number", 24));
  const address = cleanText(input.address, "Delivery address", 240);
  const notes = cleanText(input.notes || "", "Notes", 180, { optional: true });
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 30) {
    throw Object.assign(new Error("Add at least one menu item to the basket."), { status: 400 });
  }
  const seen = new Set();
  const items = input.items.map((line) => {
    if (!line || typeof line.id !== "string" || seen.has(line.id)) {
      throw Object.assign(new Error("The basket contains an invalid menu item."), { status: 400 });
    }
    seen.add(line.id);
    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      throw Object.assign(new Error("Each item quantity must be between 1 and 50."), { status: 400 });
    }
    const dish = state.menu.find((item) => item.id === line.id && item.enabled);
    if (!dish) throw Object.assign(new Error("A menu item is no longer available. Refresh the menu and try again."), { status: 409 });
    return { dishId: dish.id, name: dish.name, quantity, unitPrice: dish.price };
  });
  return {
    id: `DK-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`,
    createdAt: new Date().toISOString(),
    customerName: name,
    phone,
    address,
    notes,
    items,
    total: items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0),
    status: "new"
  };
}

function validImage(buffer, mimeType) {
  if (mimeType === "image/jpeg") return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  if (mimeType === "image/png") return buffer.length >= 20
    && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && buffer.toString("ascii", buffer.length - 8, buffer.length - 4) === "IEND";
  if (mimeType === "image/webp") return buffer.length >= 16
    && buffer.toString("ascii", 0, 4) === "RIFF"
    && buffer.readUInt32LE(4) === buffer.length - 8
    && buffer.toString("ascii", 8, 12) === "WEBP";
  return false;
}

async function serveUpload(response, filename) {
  if (!/^[a-f0-9-]+\.(?:jpe?g|png|webp)$/.test(filename)) {
    sendError(response, 404, "Photo not found.");
    return;
  }
  const file = path.join(uploadsDirectory, filename);
  try {
    const info = await fs.stat(file);
    if (!info.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(file).toLowerCase()],
      "Content-Length": info.size,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff"
    });
    createReadStream(file).pipe(response);
  } catch (error) {
    if (error.code === "ENOENT") sendError(response, 404, "Photo not found.");
    else throw error;
  }
}

async function serveStatic(response, pathname, method) {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (!publicFiles.has(relativePath) && !relativePath.startsWith("images/")) {
    sendError(response, 404, "Not found.");
    return;
  }
  const filePath = path.resolve(root, relativePath);
  if (!filePath.startsWith(`${root}${path.sep}`) || relativePath.split(/[\\/]/).some((part) => part.startsWith("."))) {
    sendError(response, 404, "Not found.");
    return;
  }
  try {
    const info = await fs.stat(filePath);
    if (!info.isFile()) throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": path.basename(filePath) === "index.html" || path.basename(filePath) === "admin.html" ? "no-cache" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff"
    });
    if (method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  } catch (error) {
    if (error.code === "ENOENT") sendError(response, 404, "Not found.");
    else throw error;
  }
}

async function handleApi(request, response, url) {
  const { pathname } = url;
  if (request.method === "GET" && pathname === "/api/menu") {
    return sendJson(response, 200, { menu: state.menu.filter((item) => item.enabled) });
  }
  if (request.method === "GET" && pathname === "/api/settings") {
    return sendJson(response, 200, {
      restaurantName: state.settings.restaurantName,
      whatsappNumber: state.settings.whatsappNumber
    });
  }
  if (request.method === "POST" && pathname === "/api/orders") {
    const ip = request.socket.remoteAddress || "unknown";
    if (!checkRateLimit(orderAttempts, ip, 20, 10 * 60 * 1000)) {
      return sendError(response, 429, "Too many order attempts. Please wait a few minutes and try again.");
    }
    if (!sameOrigin(request)) return sendError(response, 403, "Submit orders from the restaurant website.");
    const input = await readJson(request, 32 * 1024);
    const order = validateOrder(input);
    await updateState((next) => next.orders.unshift(order));
    return sendJson(response, 201, {
      order: { id: order.id, createdAt: order.createdAt, total: order.total },
      whatsappNumber: state.settings.whatsappNumber,
      restaurantName: state.settings.restaurantName
    });
  }
  if (request.method === "POST" && pathname === "/api/admin/login") {
    if (!sameOrigin(request)) return sendError(response, 403, "Sign in from this site.");
    const ip = request.socket.remoteAddress || "unknown";
    if (!checkRateLimit(loginAttempts, ip, 5, 15 * 60 * 1000)) {
      return sendError(response, 429, "Too many sign-in attempts. Please wait 15 minutes.");
    }
    const credentials = await loadAdminCredentials();
    if (!credentials) return sendError(response, 503, "Admin access is not set up yet. Run `npm run setup-admin` on the server.");
    const input = await readJson(request, 8 * 1024);
    if (!verifyPassword(input.password, credentials)) return sendError(response, 401, "The password is not correct.");
    loginAttempts.delete(ip);
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    sessions.set(token, { csrfToken, expiresAt: Date.now() + sessionLifetime });
    return sendJson(response, 200, { csrfToken }, { "Set-Cookie": cookieHeader(request, token) });
  }
  if (pathname.startsWith("/api/admin/")) {
    if (request.method === "GET" && pathname === "/api/admin/session") {
      const session = requireSession(request, response);
      if (!session) return;
      return sendJson(response, 200, { csrfToken: session.csrfToken });
    }
    if (request.method === "POST" && pathname === "/api/admin/logout") {
      const session = requireSession(request, response);
      if (!session || !requireCsrf(request, response, session)) return;
      sessions.delete(session.token);
      return sendJson(response, 200, { ok: true }, { "Set-Cookie": cookieHeader(request, "", 0) });
    }
    const session = requireSession(request, response);
    if (!session) return;
    if (request.method === "GET" && pathname === "/api/admin/orders") {
      return sendJson(response, 200, { orders: state.orders });
    }
    if (request.method === "GET" && pathname === "/api/admin/menu") {
      return sendJson(response, 200, { menu: state.menu });
    }
    if (request.method === "GET" && pathname === "/api/admin/settings") {
      return sendJson(response, 200, { settings: state.settings });
    }
    if (request.method === "POST" && pathname === "/api/admin/uploads") {
      if (!requireCsrf(request, response, session)) return;
      const input = await readJson(request, maximumUploadBytes * 2);
      const match = typeof input.dataUrl === "string" && input.dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
      if (!match) return sendError(response, 400, "Upload a JPG, PNG, or WebP photo.");
      const buffer = Buffer.from(match[2], "base64");
      if (buffer.length > maximumUploadBytes || buffer.toString("base64") !== match[2] || !validImage(buffer, match[1])) {
        return sendError(response, 400, "The photo is invalid or larger than 2 MB.");
      }
      const extension = match[1] === "image/jpeg" ? ".jpg" : match[1] === "image/png" ? ".png" : ".webp";
      const filename = `${randomUUID()}${extension}`;
      await fs.writeFile(path.join(uploadsDirectory, filename), buffer, { flag: "wx" });
      return sendJson(response, 201, { image: `/uploads/${filename}` });
    }
    if (request.method === "PUT" && pathname === "/api/admin/settings") {
      if (!requireCsrf(request, response, session)) return;
      const input = await readJson(request);
      const restaurantName = cleanText(input.restaurantName, "Restaurant name", 80);
      const whatsappNumber = String(input.whatsappNumber || "").trim();
      if (whatsappNumber && !/^\+?[0-9][0-9 ()-]{6,19}$/.test(whatsappNumber)) {
        return sendError(response, 400, "Enter a valid WhatsApp number, including its country code.");
      }
      await updateState((next) => {
        next.settings = { restaurantName, whatsappNumber: whatsappNumber.replace(/[ ()-]/g, "") };
      });
      return sendJson(response, 200, { settings: state.settings });
    }
    if (request.method === "POST" && pathname === "/api/admin/menu") {
      if (!requireCsrf(request, response, session)) return;
      const input = await readJson(request);
      const item = validateMenuItem(input);
      await updateState((next) => {
        if (next.menu.some((entry) => entry.id === item.id)) throw Object.assign(new Error("That menu item already exists."), { status: 409 });
        next.menu.push(item);
      });
      return sendJson(response, 201, { item });
    }
    const menuMatch = pathname.match(/^\/api\/admin\/menu\/([a-z0-9-]+)$/);
    if (menuMatch && request.method === "PUT") {
      if (!requireCsrf(request, response, session)) return;
      const input = await readJson(request);
      const item = validateMenuItem(input, menuMatch[1]);
      await updateState((next) => {
        const index = next.menu.findIndex((entry) => entry.id === item.id);
        if (index < 0) throw Object.assign(new Error("Menu item not found."), { status: 404 });
        next.menu[index] = item;
      });
      return sendJson(response, 200, { item });
    }
    if (menuMatch && request.method === "DELETE") {
      if (!requireCsrf(request, response, session)) return;
      await updateState((next) => {
        const originalLength = next.menu.length;
        next.menu = next.menu.filter((entry) => entry.id !== menuMatch[1]);
        if (next.menu.length === originalLength) throw Object.assign(new Error("Menu item not found."), { status: 404 });
      });
      return sendJson(response, 200, { ok: true });
    }
    const orderMatch = pathname.match(/^\/api\/admin\/orders\/([A-Za-z0-9-]+)$/);
    if (orderMatch && request.method === "PATCH") {
      if (!requireCsrf(request, response, session)) return;
      const input = await readJson(request, 8 * 1024);
      if (!orderStatuses.includes(input.status)) return sendError(response, 400, "Choose a valid order status.");
      let updated;
      await updateState((next) => {
        const order = next.orders.find((entry) => entry.id === orderMatch[1]);
        if (!order) throw Object.assign(new Error("Order not found."), { status: 404 });
        order.status = input.status;
        updated = order;
      });
      return sendJson(response, 200, { order: updated });
    }
    if (orderMatch && request.method === "DELETE") {
      if (!requireCsrf(request, response, session)) return;
      await updateState((next) => {
        const index = next.orders.findIndex((entry) => entry.id === orderMatch[1]);
        if (index < 0) throw Object.assign(new Error("Order not found."), { status: 404 });
        next.orders.splice(index, 1);
      });
      return sendJson(response, 200, { ok: true });
    }
    return sendError(response, 404, "Admin API endpoint not found.");
  }
  return sendError(response, 404, "API endpoint not found.");
}

const server = http.createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  if (requestIsSecure(request)) response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  let url;
  try {
    url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  } catch {
    return sendError(response, 400, "Invalid request URL.");
  }
  try {
    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "GET" && request.method !== "POST" && request.method !== "PUT"
          && request.method !== "PATCH" && request.method !== "DELETE") {
        return sendError(response, 405, "Method not allowed.");
      }
      return await handleApi(request, response, url);
    }
    if (url.pathname.startsWith("/uploads/") && (request.method === "GET" || request.method === "HEAD")) {
      return await serveUpload(response, path.basename(url.pathname));
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      return response.end("Method not allowed");
    }
    return await serveStatic(response, url.pathname, request.method);
  } catch (error) {
    if (error.status) return sendError(response, error.status, error.message);
    console.error("Request failed:", error);
    return sendError(response, 500, "The request could not be completed. Please try again.");
  }
});

if (require.main === module) {
  initialize().then(() => {
    server.listen(port, "0.0.0.0", () => {
      console.log(`Dastarkhwan is available at http://localhost:${port}`);
      console.log("Set up the admin with `node setup-admin.js`, then open http://localhost:4173/admin.html.");
    });
  }).catch((error) => {
    console.error("Could not start Dastarkhwan:", error);
    process.exitCode = 1;
  });
}

module.exports = { server, initialize, validateMenuItem, validateOrder, verifyPassword, dataDirectory, stateFile, adminFile };
