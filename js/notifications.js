/*
  TripSplit Notifications Module
  File: js/notifications.js

  Architecture:
  - Real-time Firestore listener using onSnapshot
  - User-scoped notifications
  - Search and filters handled client-side after optimized user query
  - Activity logs are written for notification read/delete actions
*/

import { db } from "./firebase.js";

import {
  collection,
  doc,
  updateDoc,
  deleteDoc,
  addDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import {
  qs,
  showToast
} from "./app.js";

import {
  getCurrentUserProfile
} from "./auth.js";

const NOTIFICATION_TYPES = ["expense", "payment", "trip", "reminder", "system"];

class NotificationService {
  notificationsRef() {
    return collection(db, "notifications");
  }

  activityLogsRef() {
    return collection(db, "activity_logs");
  }

  listenToUserNotifications(userId, callback, errorCallback) {
    const q = query(
      this.notificationsRef(),
      where("userId", "==", userId),
      orderBy("createdAt", "desc")
    );

    return onSnapshot(
      q,
      (snapshot) => {
        const notifications = snapshot.docs.map((item) => ({
          id: item.id,
          ...item.data()
        }));

        callback(notifications);
      },
      errorCallback
    );
  }

  async markAsRead(notificationId) {
    await updateDoc(doc(db, "notifications", notificationId), {
      isRead: true,
      readAt: serverTimestamp()
    });
  }

  async markAllAsRead(notifications) {
    const unread = notifications.filter((item) => !item.isRead);

    await Promise.all(
      unread.map((item) =>
        updateDoc(doc(db, "notifications", item.id), {
          isRead: true,
          readAt: serverTimestamp()
        })
      )
    );

    return unread.length;
  }

  async deleteNotification(notificationId) {
    await deleteDoc(doc(db, "notifications", notificationId));
  }

  async createActivityLog({ action, actorId, actorName, metadata = {} }) {
    await addDoc(this.activityLogsRef(), {
      tripId: metadata.tripId || "",
      action,
      actorId,
      actorName,
      metadata,
      createdAt: serverTimestamp()
    });
  }
}

class NotificationRenderer {
  constructor() {
    this.feed = qs("#notificationFeed");
    this.detailTitle = qs("#detailNotificationTitle");
    this.detailBody = qs("#notificationDetailBody");
  }

  escape(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  formatTimestamp(timestamp) {
    if (!timestamp?.toDate) return "Just now";

    return timestamp.toDate().toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "short"
    });
  }

  typeLabel(type) {
    if (!type) return "System";
    return String(type).charAt(0).toUpperCase() + String(type).slice(1);
  }

  renderStats(notifications) {
    const total = notifications.length;
    const unread = notifications.filter((item) => !item.isRead).length;
    const read = notifications.filter((item) => item.isRead).length;

    const today = new Date().toDateString();

    const todayCount = notifications.filter((item) => {
      if (!item.createdAt?.toDate) return false;
      return item.createdAt.toDate().toDateString() === today;
    }).length;

    qs("#totalNotificationsValue").textContent = total;
    qs("#unreadNotificationsValue").textContent = unread;
    qs("#readNotificationsValue").textContent = read;
    qs("#todayNotificationsValue").textContent = todayCount;

    const bell = qs("#notificationBellCount");
    if (bell) {
      bell.textContent = unread;
      bell.classList.toggle("hidden", unread === 0);
    }
  }

  notificationCard(item) {
    const status = item.isRead ? "read" : "unread";

    return `
      <article class="notification-card ${status}" data-notification-id="${this.escape(item.id)}">
        <div class="notification-card-header">
          <div>
            <h3>${this.escape(item.title || "Notification")}</h3>
            <p class="notification-message">${this.escape(item.message || "")}</p>
          </div>

          <span class="status-badge ${status}">
            ${status}
          </span>
        </div>

        <div class="notification-meta">
          <span class="type-badge ${this.escape(item.type || "system")}">
            ${this.escape(this.typeLabel(item.type))}
          </span>

          <span class="type-badge">
            ${this.escape(this.formatTimestamp(item.createdAt))}
          </span>
        </div>

        <div class="notification-actions">
          <button class="btn btn-light" type="button" data-view-notification="${this.escape(item.id)}">
            View
          </button>

          ${
            !item.isRead
              ? `<button class="btn btn-primary" type="button" data-mark-notification-read="${this.escape(item.id)}">
                  Mark As Read
                </button>`
              : ""
          }

          <button class="btn btn-dark" type="button" data-delete-notification="${this.escape(item.id)}">
            Delete
          </button>
        </div>
      </article>
    `;
  }

  renderFeed(notifications) {
    if (!this.feed) return;

    if (!notifications.length) {
      this.feed.innerHTML = `
        <div class="empty-state">
          No notifications found.
        </div>
      `;
      return;
    }

    this.feed.innerHTML = notifications
      .map((item) => this.notificationCard(item))
      .join("");
  }

  renderDetail(notification) {
    if (!notification) return;

    if (this.detailTitle) {
      this.detailTitle.textContent = notification.title || "Notification";
    }

    const metadata = notification.metadata || {};

    if (this.detailBody) {
      this.detailBody.innerHTML = `
        <div class="detail-item">
          <span>Type</span>
          ${this.escape(this.typeLabel(notification.type))}
        </div>

        <div class="detail-item">
          <span>Status</span>
          ${notification.isRead ? "Read" : "Unread"}
        </div>

        <div class="detail-item">
          <span>Timestamp</span>
          ${this.escape(this.formatTimestamp(notification.createdAt))}
        </div>

        <div class="detail-description">
          <strong>Message</strong>
          <p>${this.escape(notification.message || "")}</p>
        </div>

        <div class="detail-description">
          <strong>Metadata</strong>
          <pre>${this.escape(JSON.stringify(metadata, null, 2))}</pre>
        </div>
      `;
    }

    const markReadButton = qs("#detailMarkReadButton");
    if (markReadButton) {
      markReadButton.classList.toggle("hidden", Boolean(notification.isRead));
      markReadButton.dataset.notificationId = notification.id;
    }

    const deleteButton = qs("#detailDeleteButton");
    if (deleteButton) {
      deleteButton.dataset.notificationId = notification.id;
    }
  }
}

class NotificationModal {
  constructor() {
    this.modal = qs("#notificationDetailModal");
  }

  open() {
    this.modal?.classList.remove("hidden");
    document.body.classList.add("no-scroll");
  }

  close() {
    this.modal?.classList.add("hidden");
    document.body.classList.remove("no-scroll");
  }
}

class TripSplitNotifications {
  constructor() {
    this.service = new NotificationService();
    this.renderer = new NotificationRenderer();
    this.modal = new NotificationModal();

    this.user = null;
    this.profile = null;
    this.notifications = [];
    this.unsubscribe = null;
  }

  actorName() {
    return this.profile?.fullName || this.user?.email || "User";
  }

  normalizeType(type) {
    const value = String(type || "system").toLowerCase();
    return NOTIFICATION_TYPES.includes(value) ? value : "system";
  }

  getNotificationById(notificationId) {
    return this.notifications.find((item) => item.id === notificationId);
  }

  filterNotifications() {
    const search = qs("#notificationSearch")?.value?.toLowerCase() || "";
    const type = qs("#notificationTypeFilter")?.value || "all";
    const status = qs("#notificationStatusFilter")?.value || "all";

    return this.notifications.filter((item) => {
      const itemType = this.normalizeType(item.type);

      const matchesSearch =
        String(item.title || "").toLowerCase().includes(search) ||
        String(item.message || "").toLowerCase().includes(search) ||
        itemType.includes(search);

      const matchesType = type === "all" || itemType === type;
      const matchesStatus =
        status === "all" ||
        (status === "read" && item.isRead) ||
        (status === "unread" && !item.isRead);

      return matchesSearch && matchesType && matchesStatus;
    });
  }

  render() {
    const filtered = this.filterNotifications();

    this.renderer.renderStats(this.notifications);
    this.renderer.renderFeed(filtered);
  }

  listen() {
    if (!this.user?.uid) return;

    if (this.unsubscribe) {
      this.unsubscribe();
    }

    this.unsubscribe = this.service.listenToUserNotifications(
      this.user.uid,
      (notifications) => {
        this.notifications = notifications;
        this.render();
      },
      (error) => {
        console.error("Notification listener failed:", error);
        showToast("Unable to load notifications.", "error");

        const feed = qs("#notificationFeed");
        if (feed) {
          feed.innerHTML = `
            <div class="empty-state">
              Failed to load notifications. Please refresh.
            </div>
          `;
        }
      }
    );
  }

  async markAsRead(notificationId) {
    const notification = this.getNotificationById(notificationId);

    if (!notification) {
      showToast("Notification not found.", "error");
      return;
    }

    if (notification.isRead) return;

    await this.service.markAsRead(notificationId);

    await this.service.createActivityLog({
      action: "Notification Read",
      actorId: this.user.uid,
      actorName: this.actorName(),
      metadata: {
        notificationId,
        type: notification.type || "system",
        tripId: notification.metadata?.tripId || ""
      }
    });

    showToast("Notification marked as read.");
  }

  async markAllAsRead() {
    const count = await this.service.markAllAsRead(this.notifications);

    await this.service.createActivityLog({
      action: "Mark All Read",
      actorId: this.user.uid,
      actorName: this.actorName(),
      metadata: {
        count
      }
    });

    showToast(count ? `${count} notifications marked as read.` : "No unread notifications.");
  }

  async deleteNotification(notificationId) {
    const notification = this.getNotificationById(notificationId);

    if (!notification) {
      showToast("Notification not found.", "error");
      return;
    }

    const confirmed = window.confirm("Delete this notification?");
    if (!confirmed) return;

    await this.service.deleteNotification(notificationId);

    await this.service.createActivityLog({
      action: "Notification Deleted",
      actorId: this.user.uid,
      actorName: this.actorName(),
      metadata: {
        notificationId,
        type: notification.type || "system",
        tripId: notification.metadata?.tripId || ""
      }
    });

    this.modal.close();
    showToast("Notification deleted.");
  }

  async openDetail(notificationId) {
    const notification = this.getNotificationById(notificationId);

    if (!notification) {
      showToast("Notification not found.", "error");
      return;
    }

    this.renderer.renderDetail(notification);
    this.modal.open();
  }

  bindEvents() {
    document.addEventListener("click", async (event) => {
      const viewButton = event.target.closest("[data-view-notification]");
      const markButton = event.target.closest("[data-mark-notification-read]");
      const deleteButton = event.target.closest("[data-delete-notification]");
      const detailMarkButton = event.target.closest("[data-detail-mark-read]");
      const detailDeleteButton = event.target.closest("[data-detail-delete-notification]");
      const closeButton = event.target.closest("[data-close-notification-detail-modal]");
      const markAllButton = event.target.closest("[data-mark-all-read]");
      const refreshButton = event.target.closest("[data-refresh-notifications]");

      try {
        if (viewButton) {
          await this.openDetail(viewButton.dataset.viewNotification);
        }

        if (markButton) {
          await this.markAsRead(markButton.dataset.markNotificationRead);
        }

        if (deleteButton) {
          await this.deleteNotification(deleteButton.dataset.deleteNotification);
        }

        if (detailMarkButton) {
          await this.markAsRead(detailMarkButton.dataset.notificationId);
          this.modal.close();
        }

        if (detailDeleteButton) {
          await this.deleteNotification(detailDeleteButton.dataset.notificationId);
        }

        if (closeButton) {
          this.modal.close();
        }

        if (markAllButton) {
          await this.markAllAsRead();
        }

        if (refreshButton) {
          this.render();
          showToast("Notifications refreshed.");
        }
      } catch (error) {
        console.error(error);
        showToast("Notification action failed.", "error");
      }
    });

    ["#notificationSearch", "#notificationTypeFilter", "#notificationStatusFilter"].forEach(
      (selector) => {
        qs(selector)?.addEventListener("input", () => this.render());
        qs(selector)?.addEventListener("change", () => this.render());
      }
    );
  }

  async init(user, profile) {
    this.user = user;
    this.profile = profile || await getCurrentUserProfile();

    this.listen();
  }
}

const notificationsModule = new TripSplitNotifications();

document.addEventListener("DOMContentLoaded", () => {
  notificationsModule.bindEvents();
});

window.addEventListener("tripsplit:user-ready", (event) => {
  notificationsModule.init(event.detail.user, event.detail.profile);
});

export { notificationsModule };