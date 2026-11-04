(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const loginPanel = $("#login-panel");
  const dashboard = $("#admin-panel");
  const toast = $("#admin-toast");
  let csrfToken = "";
  let toastTimer;
  let refreshTimer;
  let editingImage = "";

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function money(amount) {
    return `Rs ${Number(amount).toLocaleString("en-PK", { maximumFractionDigits: 0 })}`;
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
  }

  function showError(element, message) {
    element.textContent = message;
    element.classList.remove("hidden");
  }

  async function api(url, options = {}) {
    const headers = { Accept: "application/json", ...options.headers };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.method && options.method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
    const response = await fetch(url, {
      ...options,
      headers,
      credentials: "same-origin",
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const result = await response.json();
    if (response.status === 401 && url !== "/api/admin/login") {
      const wasSignedIn = !dashboard.classList.contains("hidden");
      setSignedIn(false);
      if (wasSignedIn) showToast("Your admin session ended. Please sign in again.");
      throw new Error("Please sign in again.");
    }
    if (!response.ok) throw new Error(result.error || "The request could not be completed.");
    return result;
  }

  function setSignedIn(signedIn) {
    loginPanel.classList.toggle("hidden", signedIn);
    dashboard.classList.toggle("hidden", !signedIn);
    $("#logout-button").classList.toggle("hidden", !signedIn);
    if (!signedIn) {
      csrfToken = "";
      clearInterval(refreshTimer);
    }
  }

  async function loadDashboard() {
    const [ordersResult, menuResult, settingsResult] = await Promise.all([
      api("/api/admin/orders"),
      api("/api/admin/menu"),
      api("/api/admin/settings")
    ]);
    renderOrders(ordersResult.orders);
    renderMenu(menuResult.menu);
    $("#restaurant-name").value = settingsResult.settings.restaurantName;
    $("#whatsapp-number").value = settingsResult.settings.whatsappNumber;
  }

  function renderOrders(orders) {
    const host = $("#admin-orders-list");
    const sortedOrders = [...orders].sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt));
    $("#new-order-count").textContent = String(orders.filter((order) => order.status === "new").length);
    $("#order-total").textContent = money(orders.reduce((sum, order) => sum + (order.status === "cancelled" ? 0 : order.total), 0));
    if (!sortedOrders.length) {
      host.innerHTML = '<div class="admin-empty">No orders yet. Customer orders will appear here.</div>';
      return;
    }
    host.innerHTML = sortedOrders.map((order) => {
      const date = new Date(order.createdAt);
      const formattedDate = Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
      const itemLines = order.items.map((item) => `${escapeHtml(item.name)} × ${Number(item.quantity)}`).join("<br>");
      const phoneDigits = String(order.phone || "").replace(/\D/g, "");
      const phoneLink = phoneDigits ? `<a class="admin-contact-link" href="https://wa.me/${phoneDigits}" target="_blank" rel="noopener noreferrer">WhatsApp customer ↗</a>` : "";
      return `
        <article class="admin-order-card">
          <div class="admin-order-main">
            <div class="admin-order-title"><h3>${escapeHtml(order.customerName)}</h3><span class="admin-order-id">${escapeHtml(order.id)}</span></div>
            <div class="admin-order-date">${escapeHtml(formattedDate)} · ${escapeHtml(order.phone)}</div>
            <div class="admin-order-details"><b>Delivery address:</b> ${escapeHtml(order.address)}</div>
            ${order.notes ? `<div class="admin-order-details"><b>Customer note:</b> ${escapeHtml(order.notes)}</div>` : ""}
            <div class="admin-order-items">${itemLines}</div>
            <div class="admin-order-total">${money(order.total)}</div>
          </div>
          <div class="admin-order-controls">
            <select class="admin-status" data-order-status="${escapeHtml(order.id)}" aria-label="Status for ${escapeHtml(order.id)}">
              ${["new", "confirmed", "preparing", "ready", "completed", "cancelled"].map((status) => `<option value="${status}" ${order.status === status ? "selected" : ""}>${status.toUpperCase()}</option>`).join("")}
            </select>
            <div class="admin-order-actions">${phoneLink}<button type="button" class="admin-delete-order" data-delete-order="${escapeHtml(order.id)}">Delete order</button></div>
          </div>
        </article>`;
    }).join("");
  }

  function renderMenu(menu) {
    $("#menu-item-count").textContent = String(menu.filter((item) => item.enabled).length);
    const host = $("#admin-menu-list");
    if (!menu.length) {
      host.innerHTML = '<div class="admin-empty">No dishes have been added to the menu yet.</div>';
      return;
    }
    host.innerHTML = menu.map((item) => `
      <article class="admin-menu-row">
        <img src="${escapeHtml(item.image)}" alt="" loading="lazy">
        <div class="admin-menu-item-details"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.category)} · ${escapeHtml(item.size)}</small></div>
        <span class="admin-menu-item-price">${money(item.price)}</span>
        <span class="admin-menu-item-status${item.enabled ? "" : " unavailable"}">${item.enabled ? "AVAILABLE" : "HIDDEN"}</span>
        <div class="admin-row-actions"><button type="button" data-edit-item="${escapeHtml(item.id)}">Edit</button><button type="button" data-delete-item="${escapeHtml(item.id)}">Delete</button></div>
      </article>
    `).join("");
  }

  function openItemEditor(item = null) {
    const form = $("#item-form");
    form.reset();
    $("#item-error").classList.add("hidden");
    $("#item-id").value = item ? item.id : "";
    $("#item-dialog-title").textContent = item ? "Edit dish" : "Add a dish";
    $("#item-name").value = item ? item.name : "";
    $("#item-urdu").value = item ? item.urdu || "" : "";
    $("#item-category").value = item ? item.category : "";
    $("#item-price").value = item ? item.price : "";
    $("#item-size").value = item ? item.size : "";
    $("#item-badge").value = item ? item.badge || "" : "";
    $("#item-description").value = item ? item.description : "";
    $("#item-detail").value = item ? item.detail : "";
    $("#item-enabled").checked = item ? item.enabled : true;
    $("#item-popular").checked = item ? item.popular : false;
    editingImage = item ? item.image : "";
    const preview = $("#item-image-preview");
    if (editingImage) {
      preview.src = editingImage;
      preview.classList.remove("hidden");
    } else {
      preview.removeAttribute("src");
      preview.classList.add("hidden");
    }
    $("#item-dialog").classList.remove("hidden");
    document.body.style.overflow = "hidden";
    $("#item-name").focus();
  }

  function closeItemEditor() {
    $("#item-dialog").classList.add("hidden");
    document.body.style.overflow = "";
  }

  async function uploadImage(file) {
    if (file.size > 2 * 1024 * 1024) throw new Error("Choose an image smaller than 2 MB.");
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      throw new Error("Choose a JPG, PNG or WebP image.");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    }
    const dataUrl = `data:${file.type};base64,${btoa(chunks.join(""))}`;
    const result = await api("/api/admin/uploads", { method: "POST", body: { dataUrl } });
    return result.image;
  }

  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorHost = $("#login-error");
    errorHost.classList.add("hidden");
    const button = event.currentTarget.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const result = await api("/api/admin/login", {
        method: "POST",
        body: { password: $("#login-password").value }
      });
      csrfToken = result.csrfToken;
      $("#login-password").value = "";
      setSignedIn(true);
      await loadDashboard();
      refreshTimer = setInterval(() => {
        loadDashboard().catch((error) => showToast(error.message));
      }, 30000);
    } catch (error) {
      showError(errorHost, error.message);
    } finally {
      button.disabled = false;
    }
  });

  $("#logout-button").addEventListener("click", async () => {
    try {
      await api("/api/admin/logout", { method: "POST" });
      setSignedIn(false);
      showToast("You have signed out.");
    } catch (error) {
      showToast(error.message);
    }
  });

  $("#refresh-orders").addEventListener("click", () => {
    loadDashboard().then(() => showToast("Orders and menu refreshed.")).catch((error) => showToast(error.message));
  });

  $("#admin-orders-list").addEventListener("change", async (event) => {
    const select = event.target.closest("[data-order-status]");
    if (!select) return;
    select.disabled = true;
    try {
      await api(`/api/admin/orders/${encodeURIComponent(select.dataset.orderStatus)}`, {
        method: "PATCH",
        body: { status: select.value }
      });
      showToast("Order status updated.");
      await loadDashboard();
    } catch (error) {
      showToast(error.message);
      await loadDashboard().catch((loadError) => showToast(loadError.message));
    } finally {
      select.disabled = false;
    }
  });

  $("#admin-orders-list").addEventListener("click", async (event) => {
    const remove = event.target.closest("[data-delete-order]");
    if (!remove || !window.confirm("Permanently delete this order and its customer contact details?")) return;
    remove.disabled = true;
    try {
      await api(`/api/admin/orders/${encodeURIComponent(remove.dataset.deleteOrder)}`, { method: "DELETE" });
      await loadDashboard();
      showToast("Order and customer details deleted.");
    } catch (error) {
      showToast(error.message);
      remove.disabled = false;
    }
  });

  $("#admin-menu-list").addEventListener("click", async (event) => {
    const edit = event.target.closest("[data-edit-item]");
    if (edit) {
      try {
        const { menu } = await api("/api/admin/menu");
        const item = menu.find((entry) => entry.id === edit.dataset.editItem);
        if (item) openItemEditor(item);
      } catch (error) {
        showToast(error.message);
      }
      return;
    }
    const remove = event.target.closest("[data-delete-item]");
    if (!remove || !window.confirm("Delete this dish from the menu? Past orders keep their saved item details.")) return;
    remove.disabled = true;
    try {
      await api(`/api/admin/menu/${encodeURIComponent(remove.dataset.deleteItem)}`, { method: "DELETE" });
      await loadDashboard();
      showToast("Dish deleted from the menu.");
    } catch (error) {
      showToast(error.message);
      remove.disabled = false;
    }
  });

  $("#new-item-button").addEventListener("click", () => openItemEditor());
  $("#cancel-item").addEventListener("click", closeItemEditor);
  document.querySelectorAll('#item-dialog [data-close="item-dialog"]').forEach((button) => {
    button.addEventListener("click", closeItemEditor);
  });
  $("#item-dialog").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeItemEditor();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#item-dialog").classList.contains("hidden")) closeItemEditor();
  });

  $("#item-image-file").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const preview = $("#item-image-preview");
    preview.src = URL.createObjectURL(file);
    preview.classList.remove("hidden");
  });

  $("#item-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorHost = $("#item-error");
    errorHost.classList.add("hidden");
    const button = event.currentTarget.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const file = $("#item-image-file").files[0];
      let image = editingImage;
      if (file) image = await uploadImage(file);
      if (!image) throw new Error("Choose a dish photo before saving.");
      const input = {
        name: $("#item-name").value,
        urdu: $("#item-urdu").value,
        category: $("#item-category").value,
        price: Number($("#item-price").value),
        image,
        imageAlt: $("#item-name").value,
        badge: $("#item-badge").value,
        size: $("#item-size").value,
        description: $("#item-description").value,
        detail: $("#item-detail").value || $("#item-description").value,
        popular: $("#item-popular").checked,
        enabled: $("#item-enabled").checked
      };
      const itemId = $("#item-id").value;
      await api(itemId ? `/api/admin/menu/${encodeURIComponent(itemId)}` : "/api/admin/menu", {
        method: itemId ? "PUT" : "POST",
        body: input
      });
      closeItemEditor();
      await loadDashboard();
      showToast(itemId ? "Menu item updated." : "Dish added to the menu.");
    } catch (error) {
      showError(errorHost, error.message);
    } finally {
      button.disabled = false;
    }
  });

  $("#settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorHost = $("#settings-error");
    errorHost.classList.add("hidden");
    const button = event.currentTarget.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await api("/api/admin/settings", {
        method: "PUT",
        body: {
          restaurantName: $("#restaurant-name").value.trim(),
          whatsappNumber: $("#whatsapp-number").value.trim()
        }
      });
      showToast("Restaurant details saved.");
    } catch (error) {
      showError(errorHost, error.message);
    } finally {
      button.disabled = false;
    }
  });

  api("/api/admin/session").then((result) => {
    csrfToken = result.csrfToken;
    setSignedIn(true);
    return loadDashboard();
  }).then(() => {
    refreshTimer = setInterval(() => {
      loadDashboard().catch((error) => showToast(error.message));
    }, 30000);
  }).catch((error) => {
    if (error.message !== "Please sign in again.") showError($("#login-error"), error.message);
    setSignedIn(false);
  });
})();
