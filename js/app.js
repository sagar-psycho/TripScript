/*
  TripSplit App Utilities
  File: js/app.js

  Architecture Decision:
  This file contains shared frontend utilities used across public
  and protected pages: toast notifications, DOM helpers, formatting,
  mobile navigation helpers, and safe LocalStorage helpers.

  It does not contain Firebase authentication logic.
  Authentication is handled in auth.js.
*/

const APP_NAME = "TripSplit";

const STORAGE_KEYS = Object.freeze({
  THEME: "tripsplit_theme",
  SIDEBAR: "tripsplit_sidebar_collapsed"
});

function qs(selector, scope = document) {
  return scope.querySelector(selector);
}

function qsa(selector, scope = document) {
  return [...scope.querySelectorAll(selector)];
}

function createElement(tag, className = "", text = "") {
  const element = document.createElement(tag);

  if (className) element.className = className;
  if (text) element.textContent = text;

  return element;
}

function showToast(message, type = "success") {
  const toastRoot = qs("#toast-root");

  if (!toastRoot) {
    console.warn("Toast root not found:", message);
    return;
  }

  const toast = createElement("div", `toast ${type}`, message);
  toast.setAttribute("role", "alert");

  toastRoot.appendChild(toast);

  window.setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-8px)";

    window.setTimeout(() => {
      toast.remove();
    }, 220);
  }, 3200);
}

function safeGetStorage(key, fallback = null) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    console.error(`${APP_NAME} localStorage read failed:`, error);
    return fallback;
  }
}

function safeSetStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error(`${APP_NAME} localStorage write failed:`, error);
    return false;
  }
}

function formatCurrency(amount, currency = "INR") {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(Number(amount || 0));
}

function applySavedTheme() {
  const savedTheme = safeGetStorage(STORAGE_KEYS.THEME, "light");

  document.documentElement.dataset.theme = savedTheme;

  const themeToggle = qs("[data-theme-toggle]");

  if (themeToggle) {
    themeToggle.checked = savedTheme === "dark";
  }
}

function toggleTheme() {
  const currentTheme = document.documentElement.dataset.theme || "light";
  const nextTheme = currentTheme === "dark" ? "light" : "dark";

  document.documentElement.dataset.theme = nextTheme;
  safeSetStorage(STORAGE_KEYS.THEME, nextTheme);

  showToast(`${nextTheme === "dark" ? "Dark" : "Light"} mode enabled`);
}

function initThemeToggle() {
  applySavedTheme();

  const themeToggle = qs("[data-theme-toggle]");

  if (!themeToggle) return;

  themeToggle.addEventListener("change", toggleTheme);
}

function initSidebarToggle() {
  const sidebarToggle = qs("[data-sidebar-toggle]");
  const appShell = qs(".app-shell");

  if (!sidebarToggle || !appShell) return;

  const savedState = safeGetStorage(STORAGE_KEYS.SIDEBAR, false);

  if (savedState) {
    appShell.classList.add("sidebar-collapsed");
  }

  sidebarToggle.addEventListener("click", () => {
    appShell.classList.toggle("sidebar-collapsed");

    safeSetStorage(
      STORAGE_KEYS.SIDEBAR,
      appShell.classList.contains("sidebar-collapsed")
    );
  });
}

function initMobileSidebar() {
  const openButton = qs("[data-mobile-menu-open]");
  const closeButton = qs("[data-mobile-menu-close]");
  const sidebar = qs(".sidebar");
  const overlay = qs(".sidebar-overlay");

  if (!openButton || !closeButton || !sidebar || !overlay) return;

  const openSidebar = () => {
    sidebar.classList.add("show");
    overlay.classList.add("show");
    document.body.classList.add("no-scroll");
  };

  const closeSidebar = () => {
    sidebar.classList.remove("show");
    overlay.classList.remove("show");
    document.body.classList.remove("no-scroll");
  };

  openButton.addEventListener("click", openSidebar);
  closeButton.addEventListener("click", closeSidebar);
  overlay.addEventListener("click", closeSidebar);
}

function setActiveNavigation() {
  const currentPage = window.location.pathname.split("/").pop() || "index.html";

  qsa("[data-nav-link]").forEach((link) => {
    const href = link.getAttribute("href");

    if (href && href.includes(currentPage)) {
      link.classList.add("active");
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initThemeToggle();
  initSidebarToggle();
  initMobileSidebar();
  setActiveNavigation();
});

export {
  APP_NAME,
  STORAGE_KEYS,
  qs,
  qsa,
  createElement,
  showToast,
  safeGetStorage,
  safeSetStorage,
  formatCurrency,
  applySavedTheme
};