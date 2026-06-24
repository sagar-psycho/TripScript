/*
  TripSplit Dashboard Module
  File: js/dashboard.js

  Architecture:
  - Waits for auth.js to dispatch tripsplit:user-ready
  - Uses Firestore-ready data loading functions
  - Renders separate admin/member dashboards
  - Does not create dashboard business modules yet
*/

import { db } from "./firebase.js";

import {
  collection,
  getDocs,
  query,
  where,
  limit,
  orderBy
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import {
  qs,
  formatCurrency,
  showToast
} from "./app.js";

class DashboardService {
  async countCollection(collectionName) {
    const snapshot = await getDocs(collection(db, collectionName));
    return snapshot.size;
  }

  async getAdminStats() {
    const [trips, users, expenses, settlements] = await Promise.allSettled([
      this.countCollection("trips"),
      this.countCollection("users"),
      this.getPendingExpenseApprovals(),
      this.getPendingPaymentConfirmations()
    ]);

    return {
      totalTrips: trips.value || 0,
      totalMembers: users.value || 0,
      pendingExpenseApprovals: expenses.value || 0,
      pendingPaymentConfirmations: settlements.value || 0
    };
  }

  async getMemberStats(uid) {
    const tripsSnapshot = await getDocs(
      query(collection(db, "trips"), where("members", "array-contains", uid))
    ).catch(() => ({ size: 0 }));

    const expensesSnapshot = await getDocs(
      query(collection(db, "expenses"), where("createdBy", "==", uid))
    ).catch(() => ({ docs: [] }));

    let totalExpenses = 0;

    expensesSnapshot.docs.forEach((expenseDoc) => {
      totalExpenses += Number(expenseDoc.data().amount || 0);
    });

    return {
      myTrips: tripsSnapshot.size || 0,
      myExpenses: totalExpenses,
      amountOwed: 0,
      amountReceivable: 0
    };
  }

  async getPendingExpenseApprovals() {
    const snapshot = await getDocs(
      query(collection(db, "expenses"), where("status", "==", "pending"))
    ).catch(() => ({ size: 0 }));

    return snapshot.size || 0;
  }

  async getPendingPaymentConfirmations() {
    const snapshot = await getDocs(
      query(collection(db, "settlements"), where("status", "==", "pending"))
    ).catch(() => ({ size: 0 }));

    return snapshot.size || 0;
  }

  async getRecentActivity() {
    const snapshot = await getDocs(
      query(collection(db, "activityLogs"), orderBy("createdAt", "desc"), limit(6))
    ).catch(() => ({ docs: [] }));

    return snapshot.docs.map((docItem) => ({
      id: docItem.id,
      ...docItem.data()
    }));
  }
}

class DashboardRenderer {
  constructor(root) {
    this.root = root;
  }

  statCard(label, value) {
    return `
      <article class="stat-card">
        <span>${label}</span>
        <strong>${value}</strong>
      </article>
    `;
  }

  renderAdmin(stats, activity) {
    this.root.innerHTML = `
      <section class="dashboard-grid">
        ${this.statCard("Total Trips", stats.totalTrips)}
        ${this.statCard("Total Members", stats.totalMembers)}
        ${this.statCard("Pending Expense Approvals", stats.pendingExpenseApprovals)}
        ${this.statCard("Pending Payment Confirmations", stats.pendingPaymentConfirmations)}
      </section>

      <section class="panel-grid">
        <article class="panel-card">
          <h2>Recent Activity Timeline</h2>
          ${
            activity.length
              ? `<div class="timeline">
                  ${activity
                    .map(
                      (item) => `
                        <div class="timeline-item">
                          ${item.action || "Activity recorded"}
                        </div>
                      `
                    )
                    .join("")}
                </div>`
              : `<div class="empty-state">No activity logs found yet.</div>`
          }
        </article>

        <article class="panel-card quick-card">
          <h2>Admin Actions</h2>
          <a href="./trips.html" class="btn btn-primary">Manage Trips</a>
          <a href="./expenses.html" class="btn btn-light">Review Expenses</a>
          <a href="./settlements.html" class="btn btn-dark">Confirm Payments</a>
        </article>
      </section>
    `;
  }

  renderMember(stats) {
    this.root.innerHTML = `
      <section class="dashboard-grid">
        ${this.statCard("My Trips", stats.myTrips)}
        ${this.statCard("My Expenses", formatCurrency(stats.myExpenses))}
        ${this.statCard("Amount Owed", formatCurrency(stats.amountOwed))}
        ${this.statCard("Amount Receivable", formatCurrency(stats.amountReceivable))}
      </section>

      <section class="panel-grid">
        <article class="panel-card">
          <h2>Trip Overview</h2>
          <div class="empty-state">
            Your trips and expense activity will appear here once trip management is added.
          </div>
        </article>

        <article class="panel-card quick-card">
          <h2>Quick Actions</h2>
          <a href="./trips.html" class="btn btn-primary">View Trips</a>
          <a href="./expenses.html" class="btn btn-light">Add Expense</a>
          <a href="./settlements.html" class="btn btn-dark">Settle Up</a>
        </article>
      </section>
    `;
  }
}

class TripSplitDashboard {
  constructor() {
    this.root = qs("#dashboardContent");
    this.banner = qs("#emailVerificationBanner");
    this.service = new DashboardService();
    this.renderer = new DashboardRenderer(this.root);
  }

  toggleVerificationBanner(user) {
    if (!this.banner) return;

    if (user.emailVerified) {
      this.banner.classList.add("hidden");
    } else {
      this.banner.classList.remove("hidden");
    }
  }

  async init(user, profile) {
    if (!this.root) return;

    this.toggleVerificationBanner(user);

    try {
      if (profile?.role === "admin") {
        const [stats, activity] = await Promise.all([
          this.service.getAdminStats(),
          this.service.getRecentActivity()
        ]);

        this.renderer.renderAdmin(stats, activity);
        return;
      }

      const stats = await this.service.getMemberStats(user.uid);
      this.renderer.renderMember(stats);
    } catch (error) {
      console.error("Dashboard load failed:", error);
      showToast("Dashboard failed to load.", "error");

      this.root.innerHTML = `
        <div class="empty-state">
          Unable to load dashboard data. Please refresh the page.
        </div>
      `;
    }
  }
}

const dashboard = new TripSplitDashboard();

window.addEventListener("tripsplit:user-ready", (event) => {
  dashboard.init(event.detail.user, event.detail.profile);
});