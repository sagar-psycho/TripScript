/*
  TripSplit Expense Management Module
  File: js/expense.js

  Architecture:
  - Member expense lifecycle: add, edit own expense, view own/trip expenses, receipt upload
  - Admin review lifecycle: view all, approve, reject
  - Firestore collections: expenses, expense_approvals, activity_logs, notifications
  - Firebase Storage used for receipt upload
  - Balance calculation is intentionally excluded and reserved for settlements.js
*/

import { auth, db, storage } from "./firebase.js";

import {
  collection,
  doc,
  addDoc,
  setDoc,
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

import {
  qs,
  showToast,
  formatCurrency
} from "./app.js";

import {
  getCurrentUserProfile
} from "./auth.js";

const EXPENSE_CATEGORIES = [
  "Food",
  "Travel",
  "Hotel",
  "Fuel",
  "Shopping",
  "Activities",
  "Other"
];

class ExpenseValidator {
  static required(value) {
    return String(value || "").trim().length > 0;
  }

  static amount(value) {
    return Number(value) > 0;
  }

  static category(value) {
    return EXPENSE_CATEGORIES.includes(value);
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

  static validate(data) {
    const errors = {};

    if (!this.required(data.expenseName)) {
      errors.expenseName = "Expense name is required.";
    }

    if (!this.amount(data.amount)) {
      errors.amount = "Enter a valid amount.";
    }

    if (!this.category(data.category)) {
      errors.category = "Select a valid category.";
    }

    if (!this.required(data.tripId)) {
      errors.tripId = "Please select a trip.";
    }

    if (!this.required(data.date)) {
      errors.expenseDate = "Date is required.";
    }

    return errors;
  }
}

class ExpenseService {
  expensesRef() {
    return collection(db, "expenses");
  }

  approvalsRef() {
    return collection(db, "expense_approvals");
  }

  logsRef() {
    return collection(db, "activity_logs");
  }

  notificationsRef() {
    return collection(db, "notifications");
  }

  tripsRef() {
    return collection(db, "trips");
  }

  membersRef() {
    return collection(db, "trip_members");
  }

  async uploadReceipt(file, userId) {
    if (!file) return "";

    const safeName = file.name.replace(/[^\w.-]/g, "_");
    const path = `receipts/${userId}/${Date.now()}_${safeName}`;
    const storageRef = ref(storage, path);

    await uploadBytes(storageRef, file);
    return getDownloadURL(storageRef);
  }

  async createActivityLog({ tripId, expenseId, action, actorId, actorName, metadata = {} }) {
    await addDoc(this.logsRef(), {
      tripId: tripId || "",
      expenseId: expenseId || "",
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

  async getTrip(tripId) {
    if (!tripId) return null;

    const snapshot = await getDoc(doc(db, "trips", tripId));
    if (!snapshot.exists()) return null;

    return {
      id: snapshot.id,
      ...snapshot.data()
    };
  }

  async getUserTrips(uid, isAdmin) {
    if (isAdmin) {
      const snapshot = await getDocs(
        query(this.tripsRef(), orderBy("createdAt", "desc"), limit(100))
      );

      return snapshot.docs.map((item) => ({
        id: item.id,
        ...item.data()
      }));
    }

    const memberSnapshot = await getDocs(
      query(this.membersRef(), where("userId", "==", uid), limit(100))
    );

    const tripIds = memberSnapshot.docs.map((item) => item.data().tripId);

    const trips = await Promise.all(tripIds.map((tripId) => this.getTrip(tripId)));

    return trips.filter(Boolean);
  }

  async addExpense(data, user, profile, receiptFile) {
    const receiptUrl = await this.uploadReceipt(receiptFile, user.uid);
    const trip = await this.getTrip(data.tripId);

    const expensePayload = {
      expenseName: data.expenseName.trim(),
      amount: Number(data.amount),
      category: data.category,
      tripId: data.tripId,
      tripName: trip?.tripName || "",
      paidBy: user.uid,
      paidByName: profile?.fullName || user.email,
      paidByEmail: user.email,
      description: data.description.trim(),
      receiptUrl,
      date: data.date,
      status: "pending",
      createdBy: user.uid,
      createdByEmail: user.email,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    const expenseDoc = await addDoc(this.expensesRef(), expensePayload);

    await updateDoc(doc(db, "expenses", expenseDoc.id), {
      expenseId: expenseDoc.id
    });

    await setDoc(doc(db, "expense_approvals", expenseDoc.id), {
      expenseId: expenseDoc.id,
      tripId: data.tripId,
      status: "pending",
      submittedBy: user.uid,
      submittedByEmail: user.email,
      reviewedBy: "",
      reviewedAt: null,
      createdAt: serverTimestamp()
    });

    await this.createActivityLog({
      tripId: data.tripId,
      expenseId: expenseDoc.id,
      action: "Expense Added",
      actorId: user.uid,
      actorName: profile?.fullName || user.email,
      metadata: {
        expenseName: data.expenseName,
        amount: Number(data.amount)
      }
    });

    return expenseDoc.id;
  }

  async updateExpense(expenseId, data, user, profile, receiptFile) {
    const existing = await this.getExpense(expenseId);

    if (!existing) {
      throw new Error("Expense not found.");
    }

    if (existing.createdBy !== user.uid) {
      throw new Error("You can edit only your own expense.");
    }

    if (existing.status === "approved") {
      throw new Error("Approved expense cannot be edited.");
    }

    const receiptUrl = receiptFile
      ? await this.uploadReceipt(receiptFile, user.uid)
      : existing.receiptUrl || "";

    const trip = await this.getTrip(data.tripId);

    await updateDoc(doc(db, "expenses", expenseId), {
      expenseName: data.expenseName.trim(),
      amount: Number(data.amount),
      category: data.category,
      tripId: data.tripId,
      tripName: trip?.tripName || "",
      description: data.description.trim(),
      receiptUrl,
      date: data.date,
      status: "pending",
      updatedAt: serverTimestamp()
    });

    await updateDoc(doc(db, "expense_approvals", expenseId), {
      status: "pending",
      reviewedBy: "",
      reviewedAt: null
    }).catch(() => null);

    await this.createActivityLog({
      tripId: data.tripId,
      expenseId,
      action: "Expense Updated",
      actorId: user.uid,
      actorName: profile?.fullName || user.email,
      metadata: {
        expenseName: data.expenseName,
        amount: Number(data.amount)
      }
    });
  }

  async getExpense(expenseId) {
    const snapshot = await getDoc(doc(db, "expenses", expenseId));

    if (!snapshot.exists()) return null;

    return {
      id: snapshot.id,
      ...snapshot.data()
    };
  }

  async getAllExpenses() {
    const snapshot = await getDocs(
      query(this.expensesRef(), orderBy("createdAt", "desc"), limit(200))
    );

    return snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data()
    }));
  }

  async getMemberExpenses(uid) {
    const snapshot = await getDocs(
      query(
        this.expensesRef(),
        where("createdBy", "==", uid),
        orderBy("createdAt", "desc"),
        limit(200)
      )
    );

    return snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data()
    }));
  }

  async getPendingExpenses() {
    const snapshot = await getDocs(
      query(
        this.expensesRef(),
        where("status", "==", "pending"),
        orderBy("createdAt", "desc"),
        limit(100)
      )
    );

    return snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data()
    }));
  }

  async approveExpense(expenseId, adminUser, adminProfile) {
    const expense = await this.getExpense(expenseId);

    if (!expense) {
      throw new Error("Expense not found.");
    }

    await updateDoc(doc(db, "expenses", expenseId), {
      status: "approved",
      reviewedBy: adminUser.uid,
      reviewedByEmail: adminUser.email,
      reviewedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    await updateDoc(doc(db, "expense_approvals", expenseId), {
      status: "approved",
      reviewedBy: adminUser.uid,
      reviewedAt: serverTimestamp()
    }).catch(() => null);

    await this.createActivityLog({
      tripId: expense.tripId,
      expenseId,
      action: "Expense Approved",
      actorId: adminUser.uid,
      actorName: adminProfile?.fullName || adminUser.email,
      metadata: {
        expenseName: expense.expenseName,
        amount: expense.amount
      }
    });

    await this.createNotification({
      userId: expense.createdBy,
      title: "Expense Approved",
      message: `${expense.expenseName} has been approved.`,
      type: "expense_approval",
      metadata: {
        expenseId,
        tripId: expense.tripId
      }
    });
  }

  async rejectExpense(expenseId, adminUser, adminProfile) {
    const expense = await this.getExpense(expenseId);

    if (!expense) {
      throw new Error("Expense not found.");
    }

    await updateDoc(doc(db, "expenses", expenseId), {
      status: "rejected",
      reviewedBy: adminUser.uid,
      reviewedByEmail: adminUser.email,
      reviewedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    await updateDoc(doc(db, "expense_approvals", expenseId), {
      status: "rejected",
      reviewedBy: adminUser.uid,
      reviewedAt: serverTimestamp()
    }).catch(() => null);

    await this.createActivityLog({
      tripId: expense.tripId,
      expenseId,
      action: "Expense Rejected",
      actorId: adminUser.uid,
      actorName: adminProfile?.fullName || adminUser.email,
      metadata: {
        expenseName: expense.expenseName,
        amount: expense.amount
      }
    });

    await this.createNotification({
      userId: expense.createdBy,
      title: "Expense Rejected",
      message: `${expense.expenseName} has been rejected.`,
      type: "expense_rejection",
      metadata: {
        expenseId,
        tripId: expense.tripId
      }
    });
  }
}

class ExpenseRenderer {
  constructor() {
    this.expenseList = qs("#expenseList");
    this.approvalQueue = qs("#approvalQueue");
    this.quickSummary = qs("#expenseQuickSummary");
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

  expenseCard(expense, isAdmin) {
    const canEdit = !isAdmin && expense.status !== "approved";

    return `
      <article class="expense-card" data-expense-id="${this.escape(expense.id)}">
        <div class="expense-card-header">
          <div>
            <h3>${this.escape(expense.expenseName)}</h3>
            <p class="expense-description">${this.escape(expense.tripName || "Trip")}</p>
          </div>
          ${this.statusBadge(expense.status || "pending")}
        </div>

        <div class="amount-pill">
          ${formatCurrency(expense.amount || 0)}
        </div>

        <div class="expense-meta">
          <span>🏷️ ${this.escape(expense.category)}</span>
          <span>👤 ${this.escape(expense.paidByName || expense.paidByEmail)}</span>
          <span>📅 ${this.escape(expense.date)}</span>
        </div>

        <p class="expense-description">
          ${this.escape(expense.description || "No description added.")}
        </p>

        <div class="expense-actions">
          <button class="btn btn-light" data-view-expense="${this.escape(expense.id)}">
            View
          </button>

          ${
            canEdit
              ? `<button class="btn btn-primary" data-edit-expense="${this.escape(expense.id)}">
                  Edit
                </button>`
              : ""
          }

          ${
            isAdmin && expense.status === "pending"
              ? `
                <button class="btn btn-primary" data-approve-expense-id="${this.escape(expense.id)}">
                  Approve
                </button>
                <button class="btn btn-dark" data-reject-expense-id="${this.escape(expense.id)}">
                  Reject
                </button>
              `
              : ""
          }
        </div>
      </article>
    `;
  }

  renderExpenses(expenses, isAdmin) {
    if (!this.expenseList) return;

    if (!expenses.length) {
      this.expenseList.innerHTML = `
        <div class="empty-state">No expenses found.</div>
      `;
      return;
    }

    this.expenseList.innerHTML = expenses
      .map((expense) => this.expenseCard(expense, isAdmin))
      .join("");
  }

  renderApprovalQueue(expenses) {
    if (!this.approvalQueue) return;

    if (!expenses.length) {
      this.approvalQueue.innerHTML = `
        <div class="empty-state">No pending expenses for approval.</div>
      `;
      return;
    }

    this.approvalQueue.innerHTML = expenses
      .map(
        (expense) => `
          <article class="approval-card">
            <div class="approval-card-header">
              <div>
                <h3>${this.escape(expense.expenseName)}</h3>
                <p class="expense-description">
                  ${this.escape(expense.paidByName)} · ${this.escape(expense.tripName)}
                </p>
              </div>
              <span class="amount-pill">${formatCurrency(expense.amount || 0)}</span>
            </div>

            <div class="approval-actions">
              <button class="btn btn-light" data-view-expense="${this.escape(expense.id)}">
                View
              </button>
              <button class="btn btn-primary" data-approve-expense-id="${this.escape(expense.id)}">
                Approve
              </button>
              <button class="btn btn-dark" data-reject-expense-id="${this.escape(expense.id)}">
                Reject
              </button>
            </div>
          </article>
        `
      )
      .join("");
  }

  renderStats(expenses) {
    const total = expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const pending = expenses.filter((item) => item.status === "pending").length;
    const approved = expenses.filter((item) => item.status === "approved").length;
    const rejected = expenses.filter((item) => item.status === "rejected").length;

    qs("#totalExpensesValue").textContent = formatCurrency(total);
    qs("#pendingExpensesValue").textContent = pending;
    qs("#approvedExpensesValue").textContent = approved;
    qs("#rejectedExpensesValue").textContent = rejected;
  }

  renderQuickSummary(expenses) {
    if (!this.quickSummary) return;

    const categoryTotals = expenses.reduce((acc, item) => {
      acc[item.category] = (acc[item.category] || 0) + Number(item.amount || 0);
      return acc;
    }, {});

    const entries = Object.entries(categoryTotals);

    if (!entries.length) {
      this.quickSummary.innerHTML = `<div class="empty-state">Expense summary will appear here.</div>`;
      return;
    }

    this.quickSummary.innerHTML = entries
      .map(
        ([category, amount]) => `
          <div class="detail-item">
            <span>${this.escape(category)}</span>
            ${formatCurrency(amount)}
          </div>
        `
      )
      .join("");
  }

  renderTripOptions(trips) {
    const selects = [qs("#tripId"), qs("#expenseTripFilter")];

    selects.forEach((select) => {
      if (!select) return;

      const firstOption =
        select.id === "expenseTripFilter"
          ? `<option value="all">All Trips</option>`
          : `<option value="">Select Trip</option>`;

      select.innerHTML =
        firstOption +
        trips
          .map(
            (trip) => `
              <option value="${this.escape(trip.id)}">
                ${this.escape(trip.tripName)}
              </option>
            `
          )
          .join("");
    });
  }

  renderExpenseDetail(expense) {
    qs("#detailExpenseName").textContent = expense.expenseName;

    const body = qs("#expenseDetailBody");
    if (!body) return;

    body.innerHTML = `
      <div class="detail-grid">
        <div class="detail-item"><span>Amount</span>${formatCurrency(expense.amount || 0)}</div>
        <div class="detail-item"><span>Status</span>${this.escape(expense.status)}</div>
        <div class="detail-item"><span>Category</span>${this.escape(expense.category)}</div>
        <div class="detail-item"><span>Trip</span>${this.escape(expense.tripName)}</div>
        <div class="detail-item"><span>Paid By</span>${this.escape(expense.paidByName)}</div>
        <div class="detail-item"><span>Date</span>${this.escape(expense.date)}</div>
      </div>

      <div class="detail-description">
        ${this.escape(expense.description || "No description added.")}
      </div>

      ${
        expense.receiptUrl
          ? `<div class="receipt-preview">
              <strong>Receipt</strong><br />
              <a class="receipt-link" href="${this.escape(expense.receiptUrl)}" target="_blank" rel="noopener">
                Open Receipt
              </a>
            </div>`
          : `<div class="empty-state">No receipt uploaded.</div>`
      }
    `;
  }
}

class ExpenseModalController {
  constructor() {
    this.expenseModal = qs("#expenseModal");
    this.detailModal = qs("#expenseDetailModal");
    this.expenseForm = qs("#expenseForm");
  }

  openExpenseModal(expense = null, userProfile = null) {
    qs("#expenseModalTitle").textContent = expense ? "Edit Expense" : "Add Expense";

    this.expenseForm.expenseId.value = expense?.id || "";
    this.expenseForm.expenseName.value = expense?.expenseName || "";
    this.expenseForm.amount.value = expense?.amount || "";
    this.expenseForm.category.value = expense?.category || "";
    this.expenseForm.tripId.value = expense?.tripId || "";
    this.expenseForm.paidBy.value = expense?.paidByName || userProfile?.fullName || "";
    this.expenseForm.expenseDate.value =
      expense?.date || new Date().toISOString().slice(0, 10);
    this.expenseForm.expenseDescription.value = expense?.description || "";

    qs("#receiptPreview")?.classList.add("hidden");

    this.expenseModal.classList.remove("hidden");
    document.body.classList.add("no-scroll");
  }

  closeExpenseModal() {
    this.expenseModal.classList.add("hidden");
    this.expenseForm.reset();
    document.body.classList.remove("no-scroll");
  }

  openDetailModal() {
    this.detailModal.classList.remove("hidden");
    document.body.classList.add("no-scroll");
  }

  closeDetailModal() {
    this.detailModal.classList.add("hidden");
    document.body.classList.remove("no-scroll");
  }
}

class TripSplitExpenses {
  constructor() {
    this.service = new ExpenseService();
    this.renderer = new ExpenseRenderer();
    this.modal = new ExpenseModalController();

    this.user = null;
    this.profile = null;
    this.expenses = [];
    this.trips = [];
    this.selectedExpenseId = "";
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

    const title = qs("#expenseListTitle");
    const subtitle = qs("#expenseListSubtitle");

    if (title) title.textContent = this.isAdmin() ? "All Expenses" : "My Expenses";

    if (subtitle) {
      subtitle.textContent = this.isAdmin()
        ? "Review and manage all submitted expenses."
        : "Add, edit, and view your submitted expenses.";
    }
  }

  async loadTrips() {
    this.trips = await this.service.getUserTrips(this.user.uid, this.isAdmin());
    this.renderer.renderTripOptions(this.trips);
  }

  async loadExpenses() {
    this.expenses = this.isAdmin()
      ? await this.service.getAllExpenses()
      : await this.service.getMemberExpenses(this.user.uid);

    this.renderFilteredExpenses();
    this.renderer.renderStats(this.expenses);
    this.renderer.renderQuickSummary(this.expenses);

    if (this.isAdmin()) {
      const pending = await this.service.getPendingExpenses();
      this.renderer.renderApprovalQueue(pending);
    }
  }

  renderFilteredExpenses() {
    const search = qs("#expenseSearch")?.value?.toLowerCase() || "";
    const trip = qs("#expenseTripFilter")?.value || "all";
    const category = qs("#expenseCategoryFilter")?.value || "all";
    const status = qs("#expenseStatusFilter")?.value || "all";

    const filtered = this.expenses.filter((expense) => {
      const matchesSearch =
        expense.expenseName?.toLowerCase().includes(search) ||
        expense.category?.toLowerCase().includes(search) ||
        expense.tripName?.toLowerCase().includes(search) ||
        expense.paidByName?.toLowerCase().includes(search);

      const matchesTrip = trip === "all" || expense.tripId === trip;
      const matchesCategory = category === "all" || expense.category === category;
      const matchesStatus = status === "all" || expense.status === status;

      return matchesSearch && matchesTrip && matchesCategory && matchesStatus;
    });

    this.renderer.renderExpenses(filtered, this.isAdmin());
  }

  getFormData() {
    return {
      expenseId: qs("#expenseId")?.value || "",
      expenseName: qs("#expenseName")?.value || "",
      amount: qs("#amount")?.value || "",
      category: qs("#category")?.value || "",
      tripId: qs("#tripId")?.value || "",
      paidBy: qs("#paidBy")?.value || "",
      date: qs("#expenseDate")?.value || "",
      description: qs("#expenseDescription")?.value || ""
    };
  }

  getReceiptFile() {
    return qs("#receiptUpload")?.files?.[0] || null;
  }

  async handleExpenseSubmit(event) {
    event.preventDefault();

    if (this.isAdmin()) {
      showToast("Admins can review expenses, not add member expenses.", "error");
      return;
    }

    const form = qs("#expenseForm");
    ExpenseValidator.clearErrors(form);

    const data = this.getFormData();
    const errors = ExpenseValidator.validate(data);

    if (Object.keys(errors).length) {
      ExpenseValidator.renderErrors(errors);
      return;
    }

    const button = qs("#saveExpenseButton");
    button.disabled = true;
    button.textContent = "Submitting...";

    try {
      if (data.expenseId) {
        await this.service.updateExpense(
          data.expenseId,
          data,
          this.user,
          this.profile,
          this.getReceiptFile()
        );
        showToast("Expense updated and sent for approval.");
      } else {
        await this.service.addExpense(
          data,
          this.user,
          this.profile,
          this.getReceiptFile()
        );
        showToast("Expense submitted for approval.");
      }

      this.modal.closeExpenseModal();
      await this.loadExpenses();
    } catch (error) {
      console.error(error);
      showToast(error.message || "Unable to save expense.", "error");
    } finally {
      button.disabled = false;
      button.textContent = "Submit Expense";
    }
  }

  async openExpenseDetail(expenseId) {
    const expense = await this.service.getExpense(expenseId);

    if (!expense) {
      showToast("Expense not found.", "error");
      return;
    }

    this.selectedExpenseId = expenseId;
    this.renderer.renderExpenseDetail(expense);
    this.modal.openDetailModal();

    qs("#expenseApprovalActions")?.classList.toggle(
      "hidden",
      !(this.isAdmin() && expense.status === "pending")
    );
  }

  async editExpense(expenseId) {
    const expense = await this.service.getExpense(expenseId);

    if (!expense) {
      showToast("Expense not found.", "error");
      return;
    }

    if (expense.createdBy !== this.user.uid) {
      showToast("You can edit only your own expense.", "error");
      return;
    }

    this.modal.openExpenseModal(expense, this.profile);
  }

  async approveExpense(expenseId) {
    if (!this.isAdmin()) return;

    try {
      await this.service.approveExpense(expenseId, this.user, this.profile);
      showToast("Expense approved.");
      this.modal.closeDetailModal();
      await this.loadExpenses();
    } catch (error) {
      console.error(error);
      showToast("Unable to approve expense.", "error");
    }
  }

  async rejectExpense(expenseId) {
    if (!this.isAdmin()) return;

    try {
      await this.service.rejectExpense(expenseId, this.user, this.profile);
      showToast("Expense rejected.");
      this.modal.closeDetailModal();
      await this.loadExpenses();
    } catch (error) {
      console.error(error);
      showToast("Unable to reject expense.", "error");
    }
  }

  bindEvents() {
    document.addEventListener("click", async (event) => {
      const openExpense = event.target.closest("[data-open-expense-modal]");
      const closeExpense = event.target.closest("[data-close-expense-modal]");
      const closeDetail = event.target.closest("[data-close-expense-detail-modal]");
      const viewExpense = event.target.closest("[data-view-expense]");
      const editExpense = event.target.closest("[data-edit-expense]");
      const approveExpense = event.target.closest("[data-approve-expense-id]");
      const rejectExpense = event.target.closest("[data-reject-expense-id]");
      const detailApprove = event.target.closest("[data-approve-expense]");
      const detailReject = event.target.closest("[data-reject-expense]");

      if (openExpense) this.modal.openExpenseModal(null, this.profile);
      if (closeExpense) this.modal.closeExpenseModal();
      if (closeDetail) this.modal.closeDetailModal();

      if (viewExpense) await this.openExpenseDetail(viewExpense.dataset.viewExpense);
      if (editExpense) await this.editExpense(editExpense.dataset.editExpense);
      if (approveExpense) await this.approveExpense(approveExpense.dataset.approveExpenseId);
      if (rejectExpense) await this.rejectExpense(rejectExpense.dataset.rejectExpenseId);

      if (detailApprove) await this.approveExpense(this.selectedExpenseId);
      if (detailReject) await this.rejectExpense(this.selectedExpenseId);
    });

    qs("#expenseForm")?.addEventListener("submit", (event) => {
      this.handleExpenseSubmit(event);
    });

    ["#expenseSearch", "#expenseTripFilter", "#expenseCategoryFilter", "#expenseStatusFilter"]
      .forEach((selector) => {
        qs(selector)?.addEventListener("input", () => this.renderFilteredExpenses());
        qs(selector)?.addEventListener("change", () => this.renderFilteredExpenses());
      });

    qs("#receiptUpload")?.addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      const preview = qs("#receiptPreview");

      if (!file || !preview) return;

      preview.classList.remove("hidden");

      if (file.type.startsWith("image/")) {
        const url = URL.createObjectURL(file);
        preview.innerHTML = `<img src="${url}" alt="Receipt preview" />`;
      } else {
        preview.textContent = file.name;
      }
    });
  }

  async init(user, profile) {
    this.user = user;
    this.profile = profile || await getCurrentUserProfile();

    this.applyRoleUI();

    await this.loadTrips();
    await this.loadExpenses();
  }
}

const expensesModule = new TripSplitExpenses();

document.addEventListener("DOMContentLoaded", () => {
  expensesModule.bindEvents();
});

window.addEventListener("tripsplit:user-ready", (event) => {
  expensesModule.init(event.detail.user, event.detail.profile);
});

export { expensesModule };