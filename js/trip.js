/*
  TripSplit Trip Management Module
  File: js/trip.js

  Architecture:
  - Role-based Trip Management
  - Admin: create, edit, archive, invite members, view members
  - Member: view joined trips, accept invitations, view trip details
  - Firestore collections:
    trips, trip_members, trip_invitations, activity_logs

  Important:
  No inline HTML events are used.
  All UI actions are handled through event delegation.
*/

import { auth, db } from "./firebase.js";

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
  serverTimestamp,
  increment
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import {
  qs,
  showToast
} from "./app.js";

import {
  getCurrentUserProfile
} from "./auth.js";

class TripValidator {
  static email(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
  }

  static required(value) {
    return String(value || "").trim().length > 0;
  }

  static phone(value) {
    return /^[0-9+\-\s]{7,15}$/.test(String(value || "").trim());
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

  static validateTrip(data) {
    const errors = {};

    if (!this.required(data.tripName)) errors.tripName = "Trip name is required.";
    if (!this.required(data.destination)) errors.destination = "Destination is required.";
    if (!this.required(data.startDate)) errors.startDate = "Start date is required.";
    if (!this.required(data.endDate)) errors.endDate = "End date is required.";
    if (!this.required(data.currency)) errors.currency = "Currency is required.";

    if (data.startDate && data.endDate && data.endDate < data.startDate) {
      errors.endDate = "End date cannot be before start date.";
    }

    return errors;
  }

  static validateInvitation(data) {
    const errors = {};

    if (!this.required(data.memberName)) {
      errors.memberName = "Member name is required.";
    }

    if (!this.email(data.memberEmail)) {
      errors.inviteEmail = "Valid email is required.";
    }

    if (!this.phone(data.memberPhone)) {
      errors.memberPhone = "Valid phone number is required.";
    }

    return errors;
  }
}

class TripService {
  tripsRef() {
    return collection(db, "trips");
  }

  membersRef() {
    return collection(db, "trip_members");
  }

  invitationsRef() {
    return collection(db, "trip_invitations");
  }

  logsRef() {
    return collection(db, "activity_logs");
  }

  memberDocId(tripId, userId) {
    return `${tripId}_${userId}`;
  }

  invitationLink(inviteId, tripId) {
    const url = new URL(window.location.href);
    url.pathname = url.pathname.replace(/[^/]+$/, "trips.html");
    url.searchParams.set("inviteId", inviteId);
    url.searchParams.set("tripId", tripId);
    return url.toString();
  }

  async createActivityLog({ tripId, action, actorId, actorName, metadata = {} }) {
    await addDoc(this.logsRef(), {
      tripId,
      action,
      actorId,
      actorName,
      metadata,
      createdAt: serverTimestamp()
    });
  }

  async createTrip(data, user, profile) {
    const tripPayload = {
      tripId: "",
      tripName: data.tripName.trim(),
      destination: data.destination.trim(),
      startDate: data.startDate,
      endDate: data.endDate,
      description: data.description.trim(),
      currency: data.currency,
      createdBy: user.uid,
      createdByEmail: user.email,
      status: "active",
      memberCount: 1,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    const tripDoc = await addDoc(this.tripsRef(), tripPayload);
    const tripId = tripDoc.id;

    await updateDoc(doc(db, "trips", tripId), {
      tripId
    });

    await setDoc(doc(db, "trip_members", this.memberDocId(tripId, user.uid)), {
      tripId,
      userId: user.uid,
      userName: profile?.fullName || user.email,
      userEmail: user.email,
      role: "admin",
      joinedAt: serverTimestamp()
    });

    await this.createActivityLog({
      tripId,
      action: "Trip Created",
      actorId: user.uid,
      actorName: profile?.fullName || user.email,
      metadata: {
        tripName: data.tripName,
        destination: data.destination
      }
    });

    return tripId;
  }

  async updateTrip(tripId, data, user, profile) {
    await updateDoc(doc(db, "trips", tripId), {
      tripName: data.tripName.trim(),
      destination: data.destination.trim(),
      startDate: data.startDate,
      endDate: data.endDate,
      description: data.description.trim(),
      currency: data.currency,
      updatedAt: serverTimestamp()
    });

    await this.createActivityLog({
      tripId,
      action: "Trip Updated",
      actorId: user.uid,
      actorName: profile?.fullName || user.email,
      metadata: {
        tripName: data.tripName
      }
    });
  }

  async archiveTrip(tripId, user, profile) {
    await updateDoc(doc(db, "trips", tripId), {
      status: "archived",
      updatedAt: serverTimestamp()
    });

    await this.createActivityLog({
      tripId,
      action: "Trip Archived",
      actorId: user.uid,
      actorName: profile?.fullName || user.email
    });
  }

  async getTrip(tripId) {
    const snapshot = await getDoc(doc(db, "trips", tripId));
    if (!snapshot.exists()) return null;

    return {
      id: snapshot.id,
      ...snapshot.data()
    };
  }

  async getAdminTrips(uid) {
    const q = query(
      this.tripsRef(),
      where("createdBy", "==", uid),
      orderBy("createdAt", "desc"),
      limit(100)
    );

    const snapshot = await getDocs(q);

    return snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data()
    }));
  }

  async getMemberTrips(uid) {
    const memberQuery = query(
      this.membersRef(),
      where("userId", "==", uid),
      limit(100)
    );

    const memberSnapshot = await getDocs(memberQuery);
    const tripIds = memberSnapshot.docs.map((item) => item.data().tripId);

    const trips = await Promise.all(
      tripIds.map((tripId) => this.getTrip(tripId))
    );

    return trips.filter(Boolean);
  }

  async inviteMember(tripId, data, user, profile) {
    const invitationDoc = doc(this.invitationsRef());
    const inviteId = invitationDoc.id;

    const payload = {
      inviteId,
      tripId,
      memberName: data.memberName.trim(),
      memberEmail: data.memberEmail.trim().toLowerCase(),
      memberPhone: data.memberPhone.trim(),
      invitedBy: user.uid,
      status: "pending",
      invitationLink: this.invitationLink(inviteId, tripId),
      createdAt: serverTimestamp()
    };

    await setDoc(invitationDoc, payload);

    await this.createActivityLog({
      tripId,
      action: "Member Invited",
      actorId: user.uid,
      actorName: profile?.fullName || user.email,
      metadata: {
        memberName: payload.memberName,
        memberEmail: payload.memberEmail
      }
    });

    return payload;
  }

  async getPendingInvitationsForEmail(email) {
    const q = query(
      this.invitationsRef(),
      where("memberEmail", "==", email.toLowerCase()),
      where("status", "==", "pending"),
      limit(50)
    );

    const snapshot = await getDocs(q);

    return snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data()
    }));
  }

  async acceptInvitation(inviteId, user, profile) {
    const invitationSnapshot = await getDoc(doc(db, "trip_invitations", inviteId));

    if (!invitationSnapshot.exists()) {
      throw new Error("Invitation not found.");
    }

    const invitation = invitationSnapshot.data();

    if (invitation.status !== "pending") {
      throw new Error("Invitation is not active.");
    }

    if (
      invitation.memberEmail.toLowerCase() !== user.email.toLowerCase()
    ) {
      throw new Error("This invitation is not for your account.");
    }

    await setDoc(
      doc(db, "trip_members", this.memberDocId(invitation.tripId, user.uid)),
      {
        tripId: invitation.tripId,
        userId: user.uid,
        userName: profile?.fullName || invitation.memberName || user.email,
        userEmail: user.email,
        role: "member",
        joinedAt: serverTimestamp()
      },
      { merge: true }
    );

    await updateDoc(doc(db, "trip_invitations", inviteId), {
      status: "accepted"
    });

    await updateDoc(doc(db, "trips", invitation.tripId), {
      memberCount: increment(1),
      updatedAt: serverTimestamp()
    });

    await this.createActivityLog({
      tripId: invitation.tripId,
      action: "Member Joined",
      actorId: user.uid,
      actorName: profile?.fullName || user.email,
      metadata: {
        inviteId
      }
    });
  }

  async getTripMembers(tripId) {
    const q = query(
      this.membersRef(),
      where("tripId", "==", tripId),
      limit(200)
    );

    const snapshot = await getDocs(q);

    return snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data()
    }));
  }

  async getTripActivity(tripId = null) {
    let q;

    if (tripId) {
      q = query(
        this.logsRef(),
        where("tripId", "==", tripId),
        orderBy("createdAt", "desc"),
        limit(20)
      );
    } else {
      q = query(
        this.logsRef(),
        orderBy("createdAt", "desc"),
        limit(20)
      );
    }

    const snapshot = await getDocs(q);

    return snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data()
    }));
  }
}

class TripRenderer {
  constructor() {
    this.tripList = qs("#tripList");
    this.invitationList = qs("#invitationList");
    this.timeline = qs("#tripActivityTimeline");
    this.notice = qs("#tripPageNotice");
  }

  escape(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  showNotice(message) {
    if (!this.notice) return;

    this.notice.textContent = message;
    this.notice.classList.remove("hidden");
  }

  hideNotice() {
    if (!this.notice) return;
    this.notice.classList.add("hidden");
  }

  tripCard(trip, isAdmin) {
    const statusClass = trip.status === "archived" ? "archived" : "";

    return `
      <article class="trip-card" data-trip-id="${this.escape(trip.id)}">
        <div class="trip-card-header">
          <div>
            <h3>${this.escape(trip.tripName)}</h3>
            <p class="trip-description">${this.escape(trip.destination)}</p>
          </div>
          <span class="status-badge ${statusClass}">
            ${this.escape(trip.status || "active")}
          </span>
        </div>

        <div class="trip-meta">
          <span>📅 ${this.escape(trip.startDate)} → ${this.escape(trip.endDate)}</span>
          <span>💱 ${this.escape(trip.currency)}</span>
          <span>👥 ${Number(trip.memberCount || 0)} members</span>
        </div>

        <p class="trip-description">
          ${this.escape(trip.description || "No description added.")}
        </p>

        <div class="trip-actions">
          <button class="btn btn-light" data-view-trip="${this.escape(trip.id)}">
            View
          </button>

          ${
            isAdmin
              ? `
                <button class="btn btn-primary" data-edit-trip="${this.escape(trip.id)}">
                  Edit
                </button>

                <button class="btn btn-light" data-invite-trip="${this.escape(trip.id)}">
                  Invite
                </button>

                ${
                  trip.status !== "archived"
                    ? `<button class="btn btn-dark" data-archive-trip="${this.escape(trip.id)}">
                        Archive
                      </button>`
                    : ""
                }
              `
              : ""
          }
        </div>
      </article>
    `;
  }

  renderTrips(trips, isAdmin) {
    if (!this.tripList) return;

    if (!trips.length) {
      this.tripList.innerHTML = `
        <div class="empty-state">
          No trips found yet.
        </div>
      `;
      return;
    }

    this.tripList.innerHTML = trips
      .map((trip) => this.tripCard(trip, isAdmin))
      .join("");
  }

  renderInvitations(invitations) {
    if (!this.invitationList) return;

    if (!invitations.length) {
      this.invitationList.innerHTML = `
        <div class="empty-state">
          No pending invitations found.
        </div>
      `;
      return;
    }

    this.invitationList.innerHTML = invitations
      .map(
        (invite) => `
          <article class="invitation-card">
            <h3>Trip Invitation</h3>
            <p>Email: ${this.escape(invite.memberEmail)}</p>
            <p>Status: ${this.escape(invite.status)}</p>

            <div class="invitation-actions">
              <button class="btn btn-primary" data-accept-invite="${this.escape(invite.inviteId)}">
                Accept Invitation
              </button>
            </div>
          </article>
        `
      )
      .join("");
  }

  renderTimeline(logs) {
    if (!this.timeline) return;

    if (!logs.length) {
      this.timeline.innerHTML = `<div class="empty-state">No activity yet.</div>`;
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

  renderTripDetail(trip, members) {
    const nameTarget = qs("#detailTripName");
    const body = qs("#tripDetailBody");

    if (nameTarget) nameTarget.textContent = trip.tripName;

    if (!body) return;

    body.innerHTML = `
      <div class="detail-grid">
        <div class="detail-item">
          <span>Destination</span>
          ${this.escape(trip.destination)}
        </div>

        <div class="detail-item">
          <span>Status</span>
          ${this.escape(trip.status)}
        </div>

        <div class="detail-item">
          <span>Start Date</span>
          ${this.escape(trip.startDate)}
        </div>

        <div class="detail-item">
          <span>End Date</span>
          ${this.escape(trip.endDate)}
        </div>

        <div class="detail-item">
          <span>Currency</span>
          ${this.escape(trip.currency)}
        </div>

        <div class="detail-item">
          <span>Members</span>
          ${members.length}
        </div>
      </div>

      <div class="detail-description">
        ${this.escape(trip.description || "No description added.")}
      </div>

      <div class="detail-description">
        <h3>Members</h3>
        ${
          members.length
            ? members
                .map(
                  (member) => `
                    <p>
                      <strong>${this.escape(member.userName)}</strong>
                      — ${this.escape(member.userEmail)}
                      (${this.escape(member.role)})
                    </p>
                  `
                )
                .join("")
            : "<p>No members found.</p>"
        }
      </div>
    `;
  }
}

class TripModalController {
  constructor() {
    this.tripModal = qs("#tripModal");
    this.inviteModal = qs("#inviteModal");
    this.detailModal = qs("#tripDetailModal");
    this.tripForm = qs("#tripForm");
    this.inviteForm = qs("#inviteForm");

    this.ensureInviteFields();
  }

  ensureInviteFields() {
    const inviteEmail = qs("#inviteEmail");
    if (!inviteEmail) return;

    const form = qs("#inviteForm");
    const firstGroup = inviteEmail.closest(".form-group");

    if (!qs("#memberName")) {
      firstGroup.insertAdjacentHTML(
        "beforebegin",
        `
          <div class="form-group">
            <label for="memberName">Member Name</label>
            <input id="memberName" name="memberName" class="form-control" type="text" required />
            <small class="form-error" data-error-for="memberName"></small>
          </div>
        `
      );
    }

    if (!qs("#memberPhone")) {
      firstGroup.insertAdjacentHTML(
        "afterend",
        `
          <div class="form-group">
            <label for="memberPhone">Member Phone</label>
            <input id="memberPhone" name="memberPhone" class="form-control" type="tel" required />
            <small class="form-error" data-error-for="memberPhone"></small>
          </div>
        `
      );
    }

    form?.setAttribute("autocomplete", "off");
  }

  openTripModal(trip = null) {
    if (!this.tripModal || !this.tripForm) return;

    qs("#tripModalTitle").textContent = trip ? "Edit Trip" : "Create Trip";

    this.tripForm.tripId.value = trip?.id || "";
    this.tripForm.tripName.value = trip?.tripName || "";
    this.tripForm.destination.value = trip?.destination || "";
    this.tripForm.startDate.value = trip?.startDate || "";
    this.tripForm.endDate.value = trip?.endDate || "";
    this.tripForm.currency.value = trip?.currency || "INR";
    this.tripForm.description.value = trip?.description || "";

    this.tripModal.classList.remove("hidden");
    document.body.classList.add("no-scroll");
  }

  closeTripModal() {
    this.tripModal?.classList.add("hidden");
    this.tripForm?.reset();
    document.body.classList.remove("no-scroll");
  }

  openInviteModal(trip) {
    if (!this.inviteModal || !this.inviteForm) return;

    qs("#inviteTripTitle").textContent = `Invite to ${trip.tripName}`;
    qs("#inviteTripId").value = trip.id;

    this.inviteModal.classList.remove("hidden");
    document.body.classList.add("no-scroll");
  }

  closeInviteModal() {
    this.inviteModal?.classList.add("hidden");
    this.inviteForm?.reset();
    document.body.classList.remove("no-scroll");
  }

  openDetailModal() {
    this.detailModal?.classList.remove("hidden");
    document.body.classList.add("no-scroll");
  }

  closeDetailModal() {
    this.detailModal?.classList.add("hidden");
    document.body.classList.remove("no-scroll");
  }
}

class TripSplitTrips {
  constructor() {
    this.service = new TripService();
    this.renderer = new TripRenderer();
    this.modal = new TripModalController();

    this.user = null;
    this.profile = null;
    this.trips = [];
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

    const title = qs("#tripListTitle");
    const subtitle = qs("#tripListSubtitle");

    if (title) title.textContent = this.isAdmin() ? "Created Trips" : "Joined Trips";

    if (subtitle) {
      subtitle.textContent = this.isAdmin()
        ? "Create, edit, archive, and invite members."
        : "View trips you have joined.";
    }
  }

  async loadTrips() {
    this.trips = this.isAdmin()
      ? await this.service.getAdminTrips(this.user.uid)
      : await this.service.getMemberTrips(this.user.uid);

    this.renderFilteredTrips();
  }

  async loadInvitations() {
    if (this.isAdmin()) return;

    const invitations = await this.service.getPendingInvitationsForEmail(this.user.email);
    this.renderer.renderInvitations(invitations);
  }

  async loadTimeline(tripId = null) {
    const logs = await this.service.getTripActivity(tripId);
    this.renderer.renderTimeline(logs);
  }

  renderFilteredTrips() {
    const searchValue = qs("#tripSearch")?.value?.toLowerCase() || "";
    const statusValue = qs("#tripStatusFilter")?.value || "all";

    const filtered = this.trips.filter((trip) => {
      const matchesSearch =
        trip.tripName?.toLowerCase().includes(searchValue) ||
        trip.destination?.toLowerCase().includes(searchValue);

      const matchesStatus =
        statusValue === "all" || trip.status === statusValue;

      return matchesSearch && matchesStatus;
    });

    this.renderer.renderTrips(filtered, this.isAdmin());
  }

  getTripFormData() {
    return {
      tripId: qs("#tripId")?.value || "",
      tripName: qs("#tripName")?.value || "",
      destination: qs("#destination")?.value || "",
      startDate: qs("#startDate")?.value || "",
      endDate: qs("#endDate")?.value || "",
      currency: qs("#currency")?.value || "INR",
      description: qs("#description")?.value || ""
    };
  }

  getInviteFormData() {
    return {
      tripId: qs("#inviteTripId")?.value || "",
      memberName: qs("#memberName")?.value || "",
      memberEmail: qs("#inviteEmail")?.value || "",
      memberPhone: qs("#memberPhone")?.value || ""
    };
  }

  async handleTripSubmit(event) {
    event.preventDefault();

    if (!this.isAdmin()) {
      showToast("Only admins can manage trips.", "error");
      return;
    }

    const form = qs("#tripForm");
    TripValidator.clearErrors(form);

    const data = this.getTripFormData();
    const errors = TripValidator.validateTrip(data);

    if (Object.keys(errors).length) {
      TripValidator.renderErrors(errors);
      return;
    }

    const button = qs("#saveTripButton");
    button.disabled = true;
    button.textContent = "Saving...";

    try {
      if (data.tripId) {
        await this.service.updateTrip(data.tripId, data, this.user, this.profile);
        showToast("Trip updated successfully.");
      } else {
        await this.service.createTrip(data, this.user, this.profile);
        showToast("Trip created successfully.");
      }

      this.modal.closeTripModal();
      await this.loadTrips();
      await this.loadTimeline();
    } catch (error) {
      console.error(error);
      showToast("Unable to save trip.", "error");
    } finally {
      button.disabled = false;
      button.textContent = "Save Trip";
    }
  }

  async handleInviteSubmit(event) {
    event.preventDefault();

    if (!this.isAdmin()) {
      showToast("Only admins can invite members.", "error");
      return;
    }

    const form = qs("#inviteForm");
    TripValidator.clearErrors(form);

    const data = this.getInviteFormData();
    const errors = TripValidator.validateInvitation(data);

    if (Object.keys(errors).length) {
      TripValidator.renderErrors(errors);
      return;
    }

    const button = qs("#sendInviteButton");
    button.disabled = true;
    button.textContent = "Sending...";

    try {
      const invitation = await this.service.inviteMember(
        data.tripId,
        data,
        this.user,
        this.profile
      );

      await navigator.clipboard?.writeText(invitation.invitationLink).catch(() => null);

      showToast("Invitation created. Link copied if browser allowed.");
      this.modal.closeInviteModal();
      await this.loadTimeline();
    } catch (error) {
      console.error(error);
      showToast("Unable to send invitation.", "error");
    } finally {
      button.disabled = false;
      button.textContent = "Send Invite";
    }
  }

  async acceptInvitation(inviteId) {
    try {
      await this.service.acceptInvitation(inviteId, this.user, this.profile);
      showToast("Invitation accepted.");
      await this.loadTrips();
      await this.loadInvitations();
      await this.loadTimeline();
    } catch (error) {
      showToast(error.message || "Unable to accept invitation.", "error");
    }
  }

  async handleUrlInvitation() {
    const params = new URLSearchParams(window.location.search);
    const inviteId = params.get("inviteId");

    if (!inviteId) return;

    await this.acceptInvitation(inviteId);

    params.delete("inviteId");
    params.delete("tripId");

    const cleanUrl = `${window.location.pathname}`;
    window.history.replaceState({}, document.title, cleanUrl);
  }

  async openTripDetails(tripId) {
    try {
      const [trip, members] = await Promise.all([
        this.service.getTrip(tripId),
        this.service.getTripMembers(tripId)
      ]);

      if (!trip) {
        showToast("Trip not found.", "error");
        return;
      }

      this.renderer.renderTripDetail(trip, members);
      this.modal.openDetailModal();
      await this.loadTimeline(tripId);
    } catch (error) {
      console.error(error);
      showToast("Unable to load trip details.", "error");
    }
  }

  async editTrip(tripId) {
    if (!this.isAdmin()) return;

    const trip = await this.service.getTrip(tripId);

    if (!trip) {
      showToast("Trip not found.", "error");
      return;
    }

    this.modal.openTripModal(trip);
  }

  async archiveTrip(tripId) {
    if (!this.isAdmin()) return;

    const confirmed = window.confirm("Archive this trip?");
    if (!confirmed) return;

    try {
      await this.service.archiveTrip(tripId, this.user, this.profile);
      showToast("Trip archived.");
      await this.loadTrips();
      await this.loadTimeline();
    } catch (error) {
      console.error(error);
      showToast("Unable to archive trip.", "error");
    }
  }

  async openInvite(tripId) {
    if (!this.isAdmin()) return;

    const trip = await this.service.getTrip(tripId);

    if (!trip) {
      showToast("Trip not found.", "error");
      return;
    }

    this.modal.openInviteModal(trip);
  }

  bindEvents() {
    document.addEventListener("click", async (event) => {
      const openTrip = event.target.closest("[data-open-trip-modal]");
      const closeTrip = event.target.closest("[data-close-trip-modal]");
      const closeInvite = event.target.closest("[data-close-invite-modal]");
      const closeDetail = event.target.closest("[data-close-detail-modal]");
      const viewTrip = event.target.closest("[data-view-trip]");
      const editTrip = event.target.closest("[data-edit-trip]");
      const archiveTrip = event.target.closest("[data-archive-trip]");
      const inviteTrip = event.target.closest("[data-invite-trip]");
      const acceptInvite = event.target.closest("[data-accept-invite]");

      if (openTrip) this.modal.openTripModal();
      if (closeTrip) this.modal.closeTripModal();
      if (closeInvite) this.modal.closeInviteModal();
      if (closeDetail) this.modal.closeDetailModal();

      if (viewTrip) await this.openTripDetails(viewTrip.dataset.viewTrip);
      if (editTrip) await this.editTrip(editTrip.dataset.editTrip);
      if (archiveTrip) await this.archiveTrip(archiveTrip.dataset.archiveTrip);
      if (inviteTrip) await this.openInvite(inviteTrip.dataset.inviteTrip);
      if (acceptInvite) await this.acceptInvitation(acceptInvite.dataset.acceptInvite);
    });

    qs("#tripForm")?.addEventListener("submit", (event) => {
      this.handleTripSubmit(event);
    });

    qs("#inviteForm")?.addEventListener("submit", (event) => {
      this.handleInviteSubmit(event);
    });

    qs("#tripSearch")?.addEventListener("input", () => {
      this.renderFilteredTrips();
    });

    qs("#tripStatusFilter")?.addEventListener("change", () => {
      this.renderFilteredTrips();
    });

    qs("#refreshInvitationsButton")?.addEventListener("click", async () => {
      await this.loadInvitations();
      showToast("Invitations refreshed.");
    });
  }

  async init(user, profile) {
    this.user = user;
    this.profile = profile || await getCurrentUserProfile();

    this.applyRoleUI();

    await Promise.all([
      this.loadTrips(),
      this.loadInvitations(),
      this.loadTimeline()
    ]);

    await this.handleUrlInvitation();
  }
}

const tripsModule = new TripSplitTrips();

document.addEventListener("DOMContentLoaded", () => {
  tripsModule.bindEvents();
});

window.addEventListener("tripsplit:user-ready", (event) => {
  tripsModule.init(event.detail.user, event.detail.profile);
});

export { tripsModule };