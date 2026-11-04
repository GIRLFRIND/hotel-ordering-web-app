(() => {
  "use strict";

  const STORAGE_KEY = "dastarkhwan.app.v1";
  let MENU = Array.isArray(window.DASTARKHWAN_MENU) ? window.DASTARKHWAN_MENU : [];
  let restaurantSettings = { restaurantName: "Dastarkhwan", whatsappNumber: "" };
  const $ = (selector) => document.querySelector(selector);
  const menuGrid = $("#menu-grid");
  const heroCard = $(".hero-food");
  const heroVisual = $(".hero-visual");
  const toast = $("#toast");
  let state = loadState();
  let activeCategory = "All";
  let toastTimer;
  let installPrompt = null;
  const supportsTilt = window.matchMedia("(hover: hover) and (pointer: fine)").matches
    && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function loadState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return { cart: [], orders: [] };
      const parsed = JSON.parse(saved);
      if (!parsed || !Array.isArray(parsed.cart) || !Array.isArray(parsed.orders)) {
        throw new Error("Saved restaurant app data is not in the expected format.");
      }
      const restored = {
        cart: parsed.cart.filter((line) => Number.isInteger(line.quantity) && line.quantity > 0),
        orders: parsed.orders.filter((order) => order && Array.isArray(order.items) && typeof order.id === "string")
          .slice(0, 30)
          .map((order) => ({
            id: order.id,
            createdAt: order.createdAt,
            items: order.items.map((item) => ({
              name: String(item.name || "Menu item").slice(0, 80),
              quantity: Number.isInteger(item.quantity) ? item.quantity : 1
            })),
            total: Number.isSafeInteger(order.total) ? order.total : 0,
            submitted: order.submitted === true
          }))
      };
      if (JSON.stringify(parsed) !== JSON.stringify(restored)) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(restored));
        } catch (error) {
          console.error("Could not remove older order contact details from browser storage:", error);
        }
      }
      return restored;
    } catch (error) {
      console.error("Could not load saved basket and orders:", error);
      return { cart: [], orders: [] };
    }
  }

  function persist(nextState) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
      state = nextState;
      return true;
    } catch (error) {
      console.error("Could not save your basket or order:", error);
      showToast("Couldn't save changes on this device. Check available browser storage.");
      return false;
    }
  }

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
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
  }

  function dishById(id) {
    return MENU.find((dish) => dish.id === id);
  }

  function cartQuantity(dishId) {
    return state.cart.find((line) => line.dishId === dishId)?.quantity || 0;
  }

  function subtotal() {
    return state.cart.reduce((sum, line) => {
      const dish = dishById(line.dishId);
      return dish ? sum + dish.price * line.quantity : sum;
    }, 0);
  }

  function renderCategories() {
    const categories = ["All", ...new Set(MENU.map((dish) => dish.category))];
    if (!categories.includes(activeCategory)) activeCategory = "All";
    $("#categories").innerHTML = categories.map((category) => `
      <button class="category-button${activeCategory === category ? " active" : ""}" type="button" data-category="${escapeHtml(category)}" aria-pressed="${activeCategory === category}">${escapeHtml(category)}</button>
    `).join("");
  }

  function renderMenu() {
    const query = $("#menu-search").value.trim().toLocaleLowerCase();
    const visibleDishes = MENU.filter((dish) => {
      const matchesCategory = activeCategory === "All" || dish.category === activeCategory;
      const searchText = `${dish.name} ${dish.urdu} ${dish.category} ${dish.description}`.toLocaleLowerCase();
      return matchesCategory && searchText.includes(query);
    });

    $("#menu-count").textContent = `${visibleDishes.length} ${visibleDishes.length === 1 ? "dish" : "dishes"}`;
    $("#no-results").classList.toggle("hidden", visibleDishes.length > 0);
    menuGrid.classList.toggle("hidden", visibleDishes.length === 0);
    menuGrid.innerHTML = visibleDishes.map((dish) => `
      <article class="dish-card">
        <button class="dish-art" type="button" data-view="${escapeHtml(dish.id)}" aria-label="View ${escapeHtml(dish.name)} details">
          <img class="menu-dish-image" src="${escapeHtml(dish.image)}" alt="${escapeHtml(dish.imageAlt)}" loading="lazy" decoding="async" ${dish.imagePosition ? `style="object-position: ${escapeHtml(dish.imagePosition)}"` : ""}>
          ${dish.badge ? `<span class="dish-tag">${escapeHtml(dish.badge)}</span>` : ""}
        </button>
        <div class="dish-info">
          <div class="dish-category">${escapeHtml(dish.category)} · ${escapeHtml(dish.size)}</div>
          <div class="dish-title-row"><h3><button class="dish-name-button" type="button" data-view="${escapeHtml(dish.id)}">${escapeHtml(dish.name)}</button></h3><span class="urdu-name" lang="ur" dir="rtl">${escapeHtml(dish.urdu)}</span></div>
          <p class="dish-description">${escapeHtml(dish.description)}</p>
          <div class="dish-footer"><span class="dish-price"><small>Rs</small>${dish.price.toLocaleString("en-PK")}</span><button class="add-button" type="button" data-add="${escapeHtml(dish.id)}" aria-label="Add ${escapeHtml(dish.name)} to basket">+</button></div>
        </div>
      </article>
    `).join("");
  }

  function renderCartCount() {
    const quantity = state.cart.reduce((sum, line) => sum + line.quantity, 0);
    $("#cart-count").textContent = String(quantity);
    $("#cart-count-top").textContent = String(quantity);
    $("#nav-cart-total").textContent = money(subtotal());
  }

  function renderCart() {
    const validLines = state.cart.filter((line) => dishById(line.dishId));
    if (validLines.length !== state.cart.length && persist({ ...state, cart: validLines })) renderCartCount();

    const empty = validLines.length === 0;
    $("#cart-empty").classList.toggle("hidden", !empty);
    $("#cart-lines").classList.toggle("hidden", empty);
    $("#basket-total").classList.toggle("hidden", empty);
    $("#checkout-form").classList.toggle("hidden", empty);
    if (empty) {
      $("#cart-lines").innerHTML = "";
      return;
    }

    $("#cart-lines").innerHTML = validLines.map((line) => {
      const dish = dishById(line.dishId);
      return `
        <div class="cart-row">
          <img class="cart-thumbnail" src="${escapeHtml(dish.image)}" alt="" loading="lazy" decoding="async">
          <div class="cart-line-info"><b>${escapeHtml(dish.name)}</b><small>${money(dish.price)} each</small></div>
          <div class="quantity" aria-label="${escapeHtml(dish.name)} quantity">
            <button type="button" data-quantity="${escapeHtml(dish.id)}" data-change="-1" aria-label="Remove one ${escapeHtml(dish.name)}">−</button>
            <span>${line.quantity}</span>
            <button type="button" data-quantity="${escapeHtml(dish.id)}" data-change="1" aria-label="Add one ${escapeHtml(dish.name)}">+</button>
          </div>
        </div>`;
    }).join("");
    $("#subtotal").textContent = money(subtotal());
    $("#place-total").textContent = money(subtotal());
  }

  function renderOrders() {
    const host = $("#orders-list");
    if (!state.orders.length) {
      host.innerHTML = '<div class="order-empty"><span>🍽️</span>No recent orders on this device yet.</div>';
      return;
    }
    host.innerHTML = state.orders.map((order) => {
      const date = new Date(order.createdAt);
      const displayDate = Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
      const itemSummary = order.items.map((item) => `${escapeHtml(item.name)} × ${Number(item.quantity)}`).join(", ");
      return `
        <article class="order-card">
          <div class="order-top"><b>${escapeHtml(order.id)}</b><span>${order.submitted ? "SUBMITTED TO RESTAURANT" : "OLDER LOCAL DEMO"}</span></div>
          <div class="order-date">${escapeHtml(displayDate)}</div>
          <div class="order-details">${itemSummary}</div>
          <div class="order-total"><span>Order total</span><span>${money(order.total)}</span></div>
        </article>`;
    }).join("");
  }

  function renderDishDetail(id) {
    const dish = dishById(id);
    if (!dish) return;
    $("#dish-detail").innerHTML = `
      <div class="detail-art"><img src="${escapeHtml(dish.image)}" alt="${escapeHtml(dish.imageAlt)}"></div>
      <div class="dish-category">${escapeHtml(dish.category)} · ${escapeHtml(dish.size)}</div>
      <div class="dish-detail-title"><h2 id="dish-title">${escapeHtml(dish.name)}</h2><span class="urdu-name" lang="ur" dir="rtl">${escapeHtml(dish.urdu)}</span></div>
      <p class="dish-detail-description">${escapeHtml(dish.detail)}</p>
      <div class="dish-detail-footer"><span class="dish-price"><small>Rs</small>${dish.price.toLocaleString("en-PK")}</span><button class="add-button" type="button" data-add="${escapeHtml(dish.id)}">＋ Add to basket</button></div>`;
  }

  function renderAll() {
    renderCategories();
    renderMenu();
    renderCartCount();
    renderOrders();
  }

  async function refreshPublicData() {
    try {
      const [menuResponse, settingsResponse] = await Promise.all([
        fetch("/api/menu", { headers: { Accept: "application/json" } }),
        fetch("/api/settings", { headers: { Accept: "application/json" } })
      ]);
      if (!menuResponse.ok || !settingsResponse.ok) throw new Error("The restaurant menu is temporarily unavailable.");
      const menuData = await menuResponse.json();
      const settings = await settingsResponse.json();
      if (!Array.isArray(menuData.menu)) throw new Error("The restaurant returned an invalid menu.");
      MENU = menuData.menu.filter((dish) => dish && typeof dish.id === "string" && Number.isSafeInteger(dish.price));
      restaurantSettings = {
        restaurantName: String(settings.restaurantName || "Dastarkhwan"),
        whatsappNumber: String(settings.whatsappNumber || "")
      };
      renderAll();
    } catch (error) {
      console.error("Could not refresh the restaurant menu:", error);
      showToast("Showing the saved menu. Reconnect to refresh current prices and availability.");
    }
  }

  function applyTilt(element, event, maxAngle) {
    const bounds = element.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    element.style.setProperty("--card-y", `${(x - 0.5) * maxAngle * 2}deg`);
    element.style.setProperty("--card-x", `${(0.5 - y) * maxAngle * 2}deg`);
    element.style.setProperty("--rotate-y", `${(x - 0.5) * maxAngle * 2}deg`);
    element.style.setProperty("--rotate-x", `${(0.5 - y) * maxAngle * 2}deg`);
    element.style.setProperty("--shine-x", `${x * 100}%`);
    element.style.setProperty("--shine-y", `${y * 100}%`);
  }

  function resetTilt(element) {
    element.style.removeProperty("--card-x");
    element.style.removeProperty("--card-y");
    element.style.removeProperty("--rotate-x");
    element.style.removeProperty("--rotate-y");
    element.style.removeProperty("--shine-x");
    element.style.removeProperty("--shine-y");
  }

  if (supportsTilt) {
    heroVisual.addEventListener("pointermove", (event) => {
      const bounds = heroVisual.getBoundingClientRect();
      heroVisual.style.setProperty("--pointer-x", `${((event.clientX - bounds.left) / bounds.width) * 100}%`);
      heroVisual.style.setProperty("--pointer-y", `${((event.clientY - bounds.top) / bounds.height) * 100}%`);
      if (event.target.closest(".hero-food")) applyTilt(heroCard, event, 7);
    });
    heroCard.addEventListener("pointerleave", () => resetTilt(heroCard));

    menuGrid.addEventListener("pointermove", (event) => {
      const card = event.target.closest(".dish-card");
      if (card && menuGrid.contains(card)) applyTilt(card, event, 3.5);
    });
    menuGrid.addEventListener("pointerout", (event) => {
      const card = event.target.closest(".dish-card");
      if (card && !card.contains(event.relatedTarget)) resetTilt(card);
    });
  }

  const sections = ["home", "menu", "our-story"].map((id) => document.getElementById(id));
  const desktopLinks = document.querySelectorAll(".desktop-nav-link");
  const mobileMenuLink = document.querySelector('.mobile-nav [href="#menu"]');
  if ("IntersectionObserver" in window) {
    const sectionObserver = new IntersectionObserver((entries) => {
      const current = entries
        .filter((entry) => entry.isIntersecting)
        .sort((first, second) => second.intersectionRatio - first.intersectionRatio)[0];
      if (!current) return;
      desktopLinks.forEach((link) => link.classList.toggle("active", link.hash === `#${current.target.id}`));
      if (mobileMenuLink) mobileMenuLink.classList.toggle("active", current.target.id === "menu");
    }, { rootMargin: "-20% 0px -55% 0px", threshold: [0, 0.1, 0.25, 0.5] });
    sections.forEach((section) => sectionObserver.observe(section));
  }

  function openDialog(id) {
    $(`#${id}`).classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }

  function closeDialog(id) {
    $(`#${id}`).classList.add("hidden");
    if (!document.querySelector(".dialog-backdrop:not(.hidden)")) document.body.style.overflow = "";
  }

  function addToCart(dishId) {
    const dish = dishById(dishId);
    if (!dish) return;
    const cart = state.cart.map((line) => ({ ...line }));
    const existing = cart.find((line) => line.dishId === dishId);
    if (existing) existing.quantity += 1;
    else cart.push({ dishId, quantity: 1 });
    if (persist({ ...state, cart })) {
      renderCartCount();
      renderCart();
      showToast(`${dish.name} added to your basket.`);
    }
  }

  $("#categories").addEventListener("click", (event) => {
    const button = event.target.closest("[data-category]");
    if (!button) return;
    activeCategory = button.dataset.category;
    renderCategories();
    renderMenu();
  });

  $("#menu-search").addEventListener("input", renderMenu);
  menuGrid.addEventListener("click", (event) => {
    const addButton = event.target.closest("[data-add]");
    if (addButton) {
      addToCart(addButton.dataset.add);
      return;
    }
    const detailButton = event.target.closest("[data-view]");
    if (detailButton) {
      renderDishDetail(detailButton.dataset.view);
      openDialog("dish-backdrop");
    }
  });

  $("#dish-detail").addEventListener("click", (event) => {
    const addButton = event.target.closest("[data-add]");
    if (!addButton) return;
    addToCart(addButton.dataset.add);
    closeDialog("dish-backdrop");
  });

  document.querySelectorAll(".mobile-nav [href]").forEach((link) => {
    link.addEventListener("click", () => {
      document.querySelectorAll(".nav-link").forEach((item) => item.classList.toggle("active", item === link));
    });
  });

  $("#cart-open").addEventListener("click", () => {
    renderCart();
    openDialog("cart-backdrop");
  });
  $("#cart-open-top").addEventListener("click", () => {
    renderCart();
    openDialog("cart-backdrop");
  });
  $("#orders-button").addEventListener("click", () => {
    renderOrders();
    openDialog("orders-backdrop");
  });
  $("#nav-orders").addEventListener("click", () => {
    renderOrders();
    openDialog("orders-backdrop");
  });
  document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => closeDialog(button.dataset.close));
  });
  document.querySelectorAll(".dialog-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeDialog(backdrop.id);
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") document.querySelectorAll(".dialog-backdrop:not(.hidden)").forEach((backdrop) => closeDialog(backdrop.id));
  });

  $("#continue-shopping").addEventListener("click", () => closeDialog("order-success-backdrop"));

  $("#cart-lines").addEventListener("click", (event) => {
    const button = event.target.closest("[data-quantity]");
    if (!button) return;
    const dishId = button.dataset.quantity;
    const change = Number(button.dataset.change);
    const cart = state.cart
      .map((line) => line.dishId === dishId ? { ...line, quantity: line.quantity + change } : { ...line })
      .filter((line) => line.quantity > 0);
    if (persist({ ...state, cart })) {
      renderCart();
      renderCartCount();
    }
  });

  $("#checkout-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitButton = form.querySelector('[type="submit"]');
    $("#checkout-error").classList.add("hidden");
    if (!form.reportValidity()) return;
    if (!state.cart.length) return;

    const orderInput = {
      customerName: $("#customer-name").value.trim(),
      phone: $("#customer-phone").value.trim(),
      address: $("#customer-address").value.trim(),
      notes: $("#customer-notes").value.trim(),
      items: state.cart.map((line) => ({ id: line.dishId, quantity: line.quantity }))
    };
    submitButton.disabled = true;
    submitButton.textContent = "Submitting order…";
    fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(orderInput)
    }).then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The order could not be submitted. Please try again.");
      const localOrder = {
        id: result.order.id,
        createdAt: result.order.createdAt,
        items: state.cart.map((line) => ({ name: dishById(line.dishId).name, quantity: line.quantity })),
        total: result.order.total,
        submitted: true
      };
      const nextState = { ...state, cart: [], orders: [localOrder, ...state.orders].slice(0, 30) };
      if (!persist(nextState)) state = nextState;
      const waLink = $("#whatsapp-order-link");
      const phoneDigits = String(result.whatsappNumber || restaurantSettings.whatsappNumber).replace(/\D/g, "");
      $("#submitted-order-id").textContent = localOrder.id;
      if (phoneDigits) {
        const itemLines = localOrder.items.map((item) => `• ${item.name} x${item.quantity}`).join("\n");
        const message = [
          `Hello ${result.restaurantName || restaurantSettings.restaurantName}, I placed order ${localOrder.id}.`,
          `Name: ${orderInput.customerName}`,
          `Phone: ${orderInput.phone}`,
          `Address: ${orderInput.address}`,
          orderInput.notes ? `Notes: ${orderInput.notes}` : "",
          "Items:",
          itemLines,
          `Total: ${money(localOrder.total)}`,
          "Please confirm my order."
        ].filter(Boolean).join("\n");
        waLink.href = `https://wa.me/${phoneDigits}?text=${encodeURIComponent(message)}`;
        waLink.classList.remove("hidden");
        $("#order-whatsapp-notice").textContent = "WhatsApp will open with your order details. Tap Send there to notify the restaurant.";
      } else {
        waLink.classList.add("hidden");
        waLink.removeAttribute("href");
        $("#order-whatsapp-notice").textContent = "WhatsApp is not configured yet. Your order is in the restaurant inbox; please contact the restaurant directly to confirm.";
      }
      form.reset();
      renderAll();
      closeDialog("cart-backdrop");
      openDialog("order-success-backdrop");
    }).catch((error) => {
      console.error("Could not submit the restaurant order:", error);
      $("#checkout-error").textContent = error.message || "Could not reach the restaurant. Your order was not submitted; please try again.";
      $("#checkout-error").classList.remove("hidden");
    }).finally(() => {
      submitButton.disabled = false;
      submitButton.innerHTML = `Place order <span id="place-total">${escapeHtml(money(subtotal()))}</span>`;
    });
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    $("#install-button").classList.remove("hidden");
  });
  $("#install-button").addEventListener("click", async () => {
    if (!installPrompt) {
      showToast("Use your browser menu and choose Install app or Add to Home Screen.");
      return;
    }
    installPrompt.prompt();
    const result = await installPrompt.userChoice;
    if (result.outcome === "accepted") $("#install-button").classList.add("hidden");
    installPrompt = null;
  });
  window.addEventListener("appinstalled", () => {
    $("#install-button").classList.add("hidden");
    showToast("Dastarkhwan added to your home screen.");
  });

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch((error) => {
        console.error("Could not register offline support:", error);
      });
    });
  }

  $("#year").textContent = String(new Date().getFullYear());
  renderAll();
  refreshPublicData();
})();
