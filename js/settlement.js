/*
  TripSplit Settlement Module
  File: js/settlement.js

  Architecture:
  - Calculates balances from approved expenses only
  - Records payment proofs from members
  - Admin confirms or rejects payments
  - Writes activity_logs and notifications for every major action
  - Does not rely on backend functions; works directly with Firebase client SDK
*/

import { auth, db, storage } from "./firebase.js";

import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  updateDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import {
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";

import { qs, showToast, formatCurrency } from "./app.js";
import { getCurrentUserProfile } from "./auth.js";

class SettlementValidator {
  static required(value) {
    return String(value || "").trim().length > 0;
  }

  static amount(value) {
    return Number(value) > 0;
  }

  static clearErrors(form) {
    form.querySelectorAll(".form-error").forEach((error) => {
      error.textContent = "";
      error.classList.remove("show");
    });
  }

  static showError(field, message) {
    const target = qs(`[data-error-for="${field}"]`);
    if (!target) return;
    target.textContent = message;
    target.classList.add("show");
  }

  static renderErrors(errors) {
    Object.entries(errors).forEach(([field, message]) => {
      this.showError(field, message);
    });
  }

  static validatePayment(data) {
    const errors = {};

    if (!this.amount(data.amount)) {
      errors.paymentAmount = "Enter a valid payment amount.";
    }

    if (!this.required(data.method)) {
      errors.paymentMethod = "Select payment method.";
    }

    if (!this.required(data.referenceNumber)) {
      errors.referenceNumber = "Reference number is required.";
    }

    return errors;
  }
}

class SettlementService {
  expensesRef() {
    return collection(db, "expenses");
  }

  membersRef() {
    return collection(db, "trip_members");
  }

  settlementsRef() {
    return collection(db, "settlements");
  }

  confirmationsRef() {
    return collection(db, "payment_confirmations");
  }

  logsRef() {
    return collection(db, "activity_logs");
  }

  notificationsRef() {
    return collection(db, "notifications");
  }

  async uploadScreenshot(file, userId) {
    if (!file) return "";

    const safeName = file.name.replace(/[^\w.-]/g, "_");
    const fileRef = ref(storage, `payment_screenshots/${userId}/${Date.now()}_${safeName}`);

    await uploadBytes(fileRef, file);
    return getDownloadURL(fileRef);
  }

  async createActivityLog({ tripId = "", action, actorId, actorName, metadata = {} }) {
    await addDoc(this.logsRef(), {
      tripId,
      action,
      actorId,
      actorName,
      metadata,
      createdAt: serverTimestamp()
    });
  }

  async createNotification({ userId, title, message, type, metadata = {} }) {
    if (!userId) return;

    await addDoc(this.notificationsRef(), {
      userId,
      title,
      message,
      type,
      isRead: false,
      metadata,
      createdAt: serverTimestamp()
    });
  }

  async getApprovedExpenses() {
    const snapshot = await getDocs(
      query(
        this.expensesRef(),
        where("status", "==", "approved"),
        orderBy("createdAt", "desc"),
        limit(500)
      )
    );

    return snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data()
    }));
  }

  async getTripMembers(tripId) {
    const snapshot = await getDocs(
      query(this.membersRef(), where("tripId", "==", tripId), limit(200))
    );

    return snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data()
    }));
  }

  async getAllTripMembersForExpenses(expenses) {
    const tripIds = [...new Set(expenses.map((expense) => expense.tripId).filter(Boolean))];
    const memberMap = new Map();

    await Promise.all(
      tripIds.map(async (tripId) => {
        memberMap.set(tripId, await this.getTripMembers(tripId));
      })
    );

    return memberMap;
  }

  /*
    Balance Logic:
    For each approved expense:
    - Split amount equally among all trip members
    - Each member owes their share
    - Payer receives every other member's share
    - Net balances are simplified into payer/payee settlement suggestions
  */
  async calculateBalances() {
    const expenses = await this.getApprovedExpenses();
    const membersByTrip = await this.getAllTripMembersForExpenses(expenses);
    const balances = new Map();

    const keyFor = (tripId, userId) => `${tripId}_${userId}`;

    expenses.forEach((expense) => {
      const members = membersByTrip.get(expense.tripId) || [];
      if (!members.length) return;

      const amount = Number(expense.amount || 0);
      const share = amount / members.length;

      members.forEach((member) => {
        const key = keyFor(expense.tripId, member.userId);

        if (!balances.has(key)) {
          balances.set(key, {
            tripId: expense.tripId,
            tripName: expense.tripName || "Trip",
            userId: member.userId,
            userName: member.userName,
            userEmail: member.userEmail,
            net: 0
          });
        }

        const record = balances.get(key);
        record.net -= share;

        if (member.userId === expense.paidBy) {
          record.net += amount;
        }
      });
    });

    return this.simplifyBalances([...balances.values()]);
  }

  simplifyBalances(balanceRows) {
    const byTrip = new Map();

    balanceRows.forEach((row) => {
      if (!byTrip.has(row.tripId)) byTrip.set(row.tripId, []);
      byTrip.get(row.tripId).push(row);
    });

    const suggestions = [];

    byTrip.forEach((rows, tripId) => {
      const debtors = rows
        .filter((row) => row.net < -0.5)
        .map((row) => ({ ...row, amount: Math.abs(row.net) }))
        .sort((a, b) => b.amount - a.amount);

      const creditors = rows
        .filter((row) => row.net > 0.5)
        .map((row) => ({ ...row, amount: row.net }))
        .sort((a, b) => b.amount - a.amount);

      let i = 0;
      let j = 0;

      while (i < debtors.length && j < creditors.length) {
        const amount = Math.min(debtors[i].amount, creditors[j].amount);

        suggestions.push({
          tripId,
          tripName: debtors[i].tripName,
          fromUserId: debtors[i].userId,
          fromUserName: debtors[i].userName,
          fromUserEmail: debtors[i].userEmail,
          toUserId: creditors[j].userId,
          toUserName: creditors[j].userName,
          toUserEmail: creditors[j].userEmail,
          amount: Math.round(amount * 100) / 100,
          status: "pending"
        });

        debtors[i].amount -= amount;
        creditors[j].amount -= amount;

        if (debtors[i].amount <= 0.5) i++;
        if (creditors[j].amount <= 0.5) j++;
      }
    });

    return suggestions;
  }

  async recordPayment(data, user, profile, screenshotFile) {
    const screenshotUrl = await this.uploadScreenshot(screenshotFile, user.uid);

    const payload = {
      tripId: data.tripId || "",
      fromUserId: user.uid,
      fromUserName: profile?.fullName || user.email,
      fromUserEmail: user.email,
      toUserId: data.toUserId || "",
      toUserName: data.toUserName || "",
      toUserEmail: data.toUserEmail || "",
      amount: Number(data.amount),
      paymentMethod: data.method,
      referenceNumber: data.referenceNumber.trim(),
      screenshotUrl,
      status: "pending",
      createdBy: user.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    const settlementDoc = await addDoc(this.settlementsRef(), payload);

    await addDoc(this.confirmationsRef(), {
      settlementId: settlementDoc.id,
      tripId: data.tripId || "",
      payerId: user.uid,
      receiverId: data.toUserId || "",
      status: "pending",
      createdAt: serverTimestamp(),
      reviewedBy: "",
      reviewedAt: null
    });

    await this.createActivityLog({
      tripId: data.tripId || "",
      action: "Payment Recorded",
      actorId: user.uid,
      actorName: profile?.fullName || user.email,
      metadata: {
        settlementId: settlementDoc.id,
        amount: Number(data.amount),
        method: data.method
      }
    });

    await this.createNotification({
      userId: data.toUserId,
      title: "Payment Recorded",
      message: `${profile?.fullName || user.email} recorded a payment of ${formatCurrency(data.amount)}.`,
      type: "payment_recorded",
      metadata: {
        settlementId: settlementDoc.id,
        tripId: data.tripId || ""
      }
    });

    return settlementDoc.id;
  }

  async getSettlements(isAdmin, uid) {
    const q = isAdmin
      ? query(this.settlementsRef(), orderBy("createdAt", "desc"), limit(300))
      : query(this.settlementsRef(), where("fromUserId", "==", uid), limit(300));

    const snapshot = await getDocs(q);

    return snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data()
    }));
  }

  async getPendingConfirmations() {
    const snapshot = await getDocs(
      query(this.settlementsRef(), where("status", "==", "pending"), limit(200))
    );

    return snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data()
    }));
  }

  async confirmPayment(settlementId, adminUser, adminProfile) {
    const settlement = await this.getSettlement(settlementId);
    if (!settlement) throw new Error("Settlement not found.");

    await updateDoc(doc(db, "settlements", settlementId), {
      status: "confirmed",
      reviewedBy: adminUser.uid,
      reviewedByEmail: adminUser.email,
      reviewedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    await this.updateConfirmationStatus(settlementId, "confirmed", adminUser.uid);

    await this.createActivityLog({
      tripId: settlement.tripId,
      action: "Payment Confirmed",
      actorId: adminUser.uid,
      actorName: adminProfile?.fullName || adminUser.email,
      metadata: {
        settlementId,
        amount: settlement.amount
      }
    });

    await this.createNotification({
      userId: settlement.fromUserId,
      title: "Payment Confirmed",
      message: `Your payment of ${formatCurrency(settlement.amount)} was confirmed.`,
      type: "payment_confirmed",
      metadata: {
        settlementId,
        tripId: settlement.tripId
      }
    });
  }

  async rejectPayment(settlementId, adminUser, adminProfile) {
    const settlement = await this.getSettlement(settlementId);
    if (!settlement) throw new Error("Settlement not found.");

    await updateDoc(doc(db, "settlements", settlementId), {
      status: "rejected",
      reviewedBy: adminUser.uid,
      reviewedByEmail: adminUser.email,
      reviewedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    await this.updateConfirmationStatus(settlementId, "rejected", adminUser.uid);

    await this.createActivityLog({
      tripId: settlement.tripId,
      action: "Payment Rejected",
      actorId: adminUser.uid,
      actorName: adminProfile?.fullName || adminUser.email,
      metadata: {
        settlementId,
        amount: settlement.amount
      }
    });

    await this.createNotification({
      userId: settlement.fromUserId,
      title: "Payment Rejected",
      message: `Your payment of ${formatCurrency(settlement.amount)} was rejected.`,
      type: "payment_rejected",
      metadata: {
        settlementId,
        tripId: settlement.tripId
      }
    });
  }

  async updateConfirmationStatus(settlementId, status, reviewerId) {
    const snapshot = await getDocs(
      query(this.confirmationsRef(), where("settlementId", "==", settlementId), limit(1))
    );

    if (snapshot.empty) return;

    await updateDoc(doc(db, "payment_confirmations", snapshot.docs[0].id), {
      status,
      reviewedBy: reviewerId,
      reviewedAt: serverTimestamp()
    });
  }

  async getSettlement(settlementId) {
    const snapshot = await getDoc(doc(db, "settlements", settlementId));
    if (!snapshot.exists()) return null;

    return {
      id: snapshot.id,
      ...snapshot.data()
    };
  }

  async getActivityLogs() {
    const snapshot = await getDocs(
      query(this.logsRef(), orderBy("createdAt", "desc"), limit(40))
    );

    return snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data()
    }));
  }

  generateWhatsAppReminder(balance) {
    const message = `Hi ${balance.fromUserName}, reminder from TripSplit: you owe ${balance.toUserName} ${formatCurrency(balance.amount)} for ${balance.tripName}. Please settle when possible.`;
    return `https://wa.me/?text=${encodeURIComponent(message)}`;
  }

  async logReminder(balance, user, profile) {
    await this.createActivityLog({
      tripId: balance.tripId,
      action: "Reminder Sent",
      actorId: user.uid,
      actorName: profile?.fullName || user.email,
      metadata: {
        fromUserName: balance.fromUserName,
        toUserName: balance.toUserName,
        amount: balance.amount
      }
    });
  }
}

class SettlementRenderer {
  constructor() {
    this.balanceList = qs("#memberBalancesList");
    this.queue = qs("#paymentConfirmationQueue");
    this.timeline = qs("#settlementActivityTimeline");
  }

  escape(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  statusBadge(status) {
    return `<span class="status-badge ${this.escape(status)}">${this.escape(status)}</span>`;
  }

  renderStats({ receivable, payable, pending, completed }) {
    qs("#totalReceivableValue").textContent = formatCurrency(receivable);
    qs("#totalPayableValue").textContent = formatCurrency(payable);
    qs("#pendingConfirmationsValue").textContent = pending;
    qs("#completedSettlementsValue").textContent = completed;
  }

  renderBalances(balances, currentUserId, isAdmin) {
    if (!this.balanceList) return;

    if (!balances.length) {
      this.balanceList.innerHTML = `<div class="empty-state">No balances to settle.</div>`;
      return;
    }

    this.balanceList.innerHTML = balances
      .map((balance, index) => {
        const canPay = balance.fromUserId === currentUserId;

        return `
          <article class="balance-card" data-balance-index="${index}">
            <strong>
              ${this.escape(balance.fromUserName)} owes ${this.escape(balance.toUserName)}
              ${formatCurrency(balance.amount)}
            </strong>
            <span>${this.escape(balance.tripName)}</span>

            ${
              canPay
                ? `<button class="btn btn-primary" data-record-balance="${index}">
                    Record Payment
                  </button>`
                : ""
            }

            ${
              isAdmin
                ? `<a class="btn btn-light" target="_blank" rel="noopener" data-reminder-balance="${index}">
                    WhatsApp Reminder
                  </a>`
                : ""
            }
          </article>
        `;
      })
      .join("");
  }

  renderQueue(settlements, isAdmin) {
    if (!this.queue) return;

    if (!settlements.length) {
      this.queue.innerHTML = `<div class="empty-state">No pending payment confirmations.</div>`;
      return;
    }

    this.queue.innerHTML = settlements
      .map(
        (item) => `
          <article class="confirmation-card">
            <div class="confirmation-card-header">
              <div>
                <h3>${this.escape(item.fromUserName)} paid ${this.escape(item.toUserName || "Receiver")}</h3>
                <span>${formatCurrency(item.amount)} · ${this.escape(item.paymentMethod)}</span>
              </div>
              ${this.statusBadge(item.status || "pending")}
            </div>

            <div class="confirmation-meta">
              <span>Reference: ${this.escape(item.referenceNumber)}</span>
              ${
                item.screenshotUrl
                  ? `<a class="receipt-link" href="${this.escape(item.screenshotUrl)}" target="_blank" rel="noopener">Open Screenshot</a>`
                  : `<span>No screenshot uploaded</span>`
              }
            </div>

            ${
              isAdmin && item.status === "pending"
                ? `<div class="confirmation-actions">
                    <button class="btn btn-primary" data-confirm-payment="${this.escape(item.id)}">
                      Accept Payment
                    </button>
                    <button class="btn btn-dark" data-reject-payment="${this.escape(item.id)}">
                      Reject Payment
                    </button>
                  </div>`
                : ""
            }
          </article>
        `
      )
      .join("");
  }

  renderTimeline(logs) {
    if (!this.timeline) return;

    if (!logs.length) {
      this.timeline.innerHTML = `<div class="empty-state">No settlement activity yet.</div>`;
      return;
    }

    this.timeline.innerHTML = logs
      .map(
        (log) => `
          <div class="timeline-item">
            <strong>${this.escape(log.action)}</strong>
            <span>${this.escape(log.actorName || "Unknown user")}</span>
          </div>
        `
      )
      .join("");
  }
}

class SettlementModal {
  constructor() {
    this.modal = qs("#paymentModal");
    this.form = qs("#paymentForm");
  }

  open(balance = null) {
    if (!this.modal || !this.form) return;

    this.form.dataset.balance = balance ? JSON.stringify(balance) : "";
    this.form.paymentAmount.value = balance?.amount || "";
    this.form.paymentMethod.value = "";
    this.form.referenceNumber.value = "";

    qs("#paymentScreenshotPreview")?.classList.add("hidden");

    this.modal.classList.remove("hidden");
    document.body.classList.add("no-scroll");
  }

  close() {
    this.modal?.classList.add("hidden");
    this.form?.reset();
    document.body.classList.remove("no-scroll");
  }
}

class TripSplitSettlements {
  constructor() {
    this.service = new SettlementService();
    this.renderer = new SettlementRenderer();
    this.modal = new SettlementModal();

    this.user = null;
    this.profile = null;
    this.balances = [];
    this.settlements = [];
  }

  isAdmin() {
    return this.profile?.role === "admin";
  }

  applyRoleUI() {
    document.querySelectorAll(".admin-only").forEach((element) => {
      element.classList.toggle("hidden", !this.isAdmin());
    });

    document.querySelectorAll(".member-only").forEach((element) => {
      element.classList.toggle("hidden", this.isAdmin());
    });
  }

  calculateStats() {
    const receivable = this.balances
      .filter((item) => item.toUserId === this.user.uid)
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);

    const payable = this.balances
      .filter((item) => item.fromUserId === this.user.uid)
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);

    const pending = this.settlements.filter((item) => item.status === "pending").length;
    const completed = this.settlements.filter((item) => item.status === "confirmed").length;

    return { receivable, payable, pending, completed };
  }

  renderFilteredQueue() {
    const search = qs("#settlementSearch")?.value?.toLowerCase() || "";
    const status = qs("#settlementStatusFilter")?.value || "all";
    const method = qs("#settlementMethodFilter")?.value || "all";

    const filtered = this.settlements.filter((item) => {
      const matchesSearch =
        item.fromUserName?.toLowerCase().includes(search) ||
        item.toUserName?.toLowerCase().includes(search) ||
        item.referenceNumber?.toLowerCase().includes(search) ||
        item.paymentMethod?.toLowerCase().includes(search);

      const matchesStatus = status === "all" || item.status === status;
      const matchesMethod = method === "all" || item.paymentMethod === method;

      return matchesSearch && matchesStatus && matchesMethod;
    });

    this.renderer.renderQueue(filtered, this.isAdmin());
  }

  async loadData() {
    this.balances = await this.service.calculateBalances();
    this.settlements = this.isAdmin()
      ? await this.service.getSettlements(true, this.user.uid)
      : await this.service.getSettlements(false, this.user.uid);

    const logs = await this.service.getActivityLogs();

    const visibleBalances = this.isAdmin()
      ? this.balances
      : this.balances.filter(
          (item) => item.fromUserId === this.user.uid || item.toUserId === this.user.uid
        );

    this.renderer.renderBalances(visibleBalances, this.user.uid, this.isAdmin());
    this.renderer.renderStats(this.calculateStats());
    this.renderFilteredQueue();
    this.renderer.renderTimeline(logs);
  }

  getPaymentFormData() {
    const form = qs("#paymentForm");
    const balance = form?.dataset.balance ? JSON.parse(form.dataset.balance) : {};

    return {
      ...balance,
      amount: qs("#paymentAmount")?.value || "",
      method: qs("#paymentMethod")?.value || "",
      referenceNumber: qs("#referenceNumber")?.value || ""
    };
  }

  getScreenshotFile() {
    return qs("#paymentScreenshot")?.files?.[0] || null;
  }

  async handlePaymentSubmit(event) {
    event.preventDefault();

    const form = qs("#paymentForm");
    SettlementValidator.clearErrors(form);

    const data = this.getPaymentFormData();
    const errors = SettlementValidator.validatePayment(data);

    if (Object.keys(errors).length) {
      SettlementValidator.renderErrors(errors);
      return;
    }

    const button = qs("#savePaymentButton");
    button.disabled = true;
    button.textContent = "Submitting...";

    try {
      await this.service.recordPayment(
        data,
        this.user,
        this.profile,
        this.getScreenshotFile()
      );

      showToast("Payment recorded for confirmation.");
      this.modal.close();
      await this.loadData();
    } catch (error) {
      console.error(error);
      showToast("Unable to record payment.", "error");
    } finally {
      button.disabled = false;
      button.textContent = "Submit Payment";
    }
  }

  async confirmPayment(settlementId) {
    try {
      await this.service.confirmPayment(settlementId, this.user, this.profile);
      showToast("Payment confirmed.");
      await this.loadData();
    } catch (error) {
      console.error(error);
      showToast("Unable to confirm payment.", "error");
    }
  }

  async rejectPayment(settlementId) {
    try {
      await this.service.rejectPayment(settlementId, this.user, this.profile);
      showToast("Payment rejected.");
      await this.loadData();
    } catch (error) {
      console.error(error);
      showToast("Unable to reject payment.", "error");
    }
  }

  bindEvents() {
    document.addEventListener("click", async (event) => {
      const openPayment = event.target.closest("[data-open-payment-modal]");
      const closePayment = event.target.closest("[data-close-payment-modal]");
      const recordBalance = event.target.closest("[data-record-balance]");
      const confirm = event.target.closest("[data-confirm-payment]");
      const reject = event.target.closest("[data-reject-payment]");
      const reminder = event.target.closest("[data-reminder-balance]");

      if (openPayment) this.modal.open();

      if (closePayment) this.modal.close();

      if (recordBalance) {
        const balance = this.balances[Number(recordBalance.dataset.recordBalance)];
        this.modal.open(balance);
      }

      if (confirm) await this.confirmPayment(confirm.dataset.confirmPayment);
      if (reject) await this.rejectPayment(reject.dataset.rejectPayment);

      if (reminder) {
        const balance = this.balances[Number(reminder.dataset.reminderBalance)];
        reminder.href = this.service.generateWhatsAppReminder(balance);
        await this.service.logReminder(balance, this.user, this.profile);
      }
    });

    qs("#paymentForm")?.addEventListener("submit", (event) => {
      this.handlePaymentSubmit(event);
    });

    ["#settlementSearch", "#settlementStatusFilter", "#settlementMethodFilter"].forEach(
      (selector) => {
        qs(selector)?.addEventListener("input", () => this.renderFilteredQueue());
        qs(selector)?.addEventListener("change", () => this.renderFilteredQueue());
      }
    );

    qs("#paymentScreenshot")?.addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      const preview = qs("#paymentScreenshotPreview");

      if (!file || !preview) return;

      preview.classList.remove("hidden");

      if (file.type.startsWith("image/")) {
        const url = URL.createObjectURL(file);
        preview.innerHTML = `<img src="${url}" alt="Payment screenshot preview" />`;
      } else {
        preview.textContent = file.name;
      }
    });
  }

  async init(user, profile) {
    this.user = user;
    this.profile = profile || await getCurrentUserProfile();

    this.applyRoleUI();
    await this.loadData();
  }
}

const settlementsModule = new TripSplitSettlements();

document.addEventListener("DOMContentLoaded", () => {
  settlementsModule.bindEvents();
});

window.addEventListener("tripsplit:user-ready", (event) => {
  settlementsModule.init(event.detail.user, event.detail.profile);
});

export { settlementsModule };