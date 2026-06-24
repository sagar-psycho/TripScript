/*
  TripSplit Authentication Module
  File: js/auth.js

  Architecture:
  - Centralized Firebase Authentication logic
  - Firestore user profile management
  - Admin/member role assignment
  - Email verification workflow
  - Protected/public route guards
  - Reusable profile helpers
  - Prepared invitation architecture for future trip onboarding
*/

import { auth, db } from "./firebase.js";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  sendEmailVerification,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import { qs, showToast } from "./app.js";

/*
  Change this email to your actual first admin account.
  Architecture Decision:
  The initial admin is identified by email during registration.
  Later, admin management can be moved into Firestore permissions.
*/
const INITIAL_ADMIN_EMAIL = "kothakulasagar2002@gmail.com";

async function createActivityLog() {
  return Promise.resolve();
}

class AuthValidator {
  static email(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
  }

  static password(password) {
    return String(password || "").length >= 6;
  }

  static name(name) {
    return String(name || "").trim().length >= 2;
  }

  static phone(phone) {
    if (!phone) return true;
    return /^[0-9+\-\s]{7,15}$/.test(String(phone).trim());
  }

  static clearErrors(form) {
    form.querySelectorAll(".form-error").forEach((error) => {
      error.textContent = "";
      error.classList.remove("show");
    });
  }

  static showFieldError(field, message) {
    const target = qs(`[data-error-for="${field}"]`);
    if (!target) return;

    target.textContent = message;
    target.classList.add("show");
  }

  static renderErrors(errors) {
    Object.entries(errors).forEach(([field, message]) => {
      this.showFieldError(field, message);
    });
  }

  static validateRegister(data) {
    const errors = {};

    if (!this.name(data.fullName)) {
      errors.fullName = "Full name must be at least 2 characters.";
    }

    if (!this.email(data.email)) {
      errors.email = "Enter a valid email address.";
    }

    if (!this.password(data.password)) {
      errors.password = "Password must be at least 6 characters.";
    }

    if (!this.phone(data.phone)) {
      errors.phone = "Enter a valid phone number.";
    }

    return errors;
  }

  static validateLogin(data) {
    const errors = {};

    if (!this.email(data.email)) {
      errors.email = "Enter a valid email address.";
    }

    if (!this.password(data.password)) {
      errors.password = "Password must be at least 6 characters.";
    }

    return errors;
  }

  static validateForgotPassword(data) {
    const errors = {};

    if (!this.email(data.email)) {
      errors.email = "Enter a valid email address.";
    }

    return errors;
  }
}

class AuthErrorHandler {
  static getMessage(error) {
    const messages = {
      "auth/email-already-in-use": "This email is already registered.",
      "auth/invalid-email": "Invalid email address.",
      "auth/user-not-found": "No account found with this email.",
      "auth/wrong-password": "Incorrect password.",
      "auth/invalid-credential": "Invalid email or password.",
      "auth/weak-password": "Password must be at least 6 characters.",
      "auth/network-request-failed": "Network error. Please try again.",
      "auth/too-many-requests": "Too many attempts. Try again later."
    };

    return messages[error?.code] || "Something went wrong. Please try again.";
  }
}

class TripSplitAuthService {
  constructor() {
    this.authPages = ["login.html", "register.html", "forgot.html"];
    this.protectedPages = [
      "dashboard.html",
      "trips.html",
      "expenses.html",
      "settlements.html",
      "reports.html",
      "settings.html"
    ];
  }

  getCurrentPage() {
    return window.location.pathname.split("/").pop() || "index.html";
  }

  isAuthPage() {
    return this.authPages.includes(this.getCurrentPage());
  }

  isProtectedPage() {
    return this.protectedPages.includes(this.getCurrentPage());
  }

  redirectToDashboard() {
    window.location.href = "./dashboard.html";
  }

  redirectToLogin() {
    window.location.href = "./login.html";
  }

  getUserRef(uid) {
    return doc(db, "users", uid);
  }

  getUserRole(email) {
    return email.trim().toLowerCase() === INITIAL_ADMIN_EMAIL.toLowerCase()
      ? "admin"
      : "member";
  }

  /*
    Trip Invitation Architecture Placeholder:
    Later, when invite links are added, this method can read invite tokens
    from URL params and attach the registered user to joinedTrips.
  */
  getPendingTripInvite() {
    const params = new URLSearchParams(window.location.search);

    return {
      inviteId: params.get("invite"),
      tripId: params.get("tripId")
    };
  }

  async createUserProfile(user, profileData) {
    const userRef = this.getUserRef(user.uid);
    const snapshot = await getDoc(userRef);

    if (snapshot.exists()) return snapshot.data();

    const pendingInvite = this.getPendingTripInvite();

    const profile = {
      uid: user.uid,
      fullName: profileData.fullName.trim(),
      email: user.email,
      phone: profileData.phone || "",
      role: this.getUserRole(user.email),
      status: "active",
      isEmailVerified: user.emailVerified,
      profileImage: "",
      joinedTrips: pendingInvite.tripId ? [pendingInvite.tripId] : [],
      createdAt: serverTimestamp(),
      lastLogin: serverTimestamp(),
      notificationSettings: {
        email: true,
        whatsapp: true
      },
      invitationMeta: {
        inviteId: pendingInvite.inviteId || "",
        registeredFromInvite: Boolean(pendingInvite.inviteId)
      }
    };

    await setDoc(userRef, profile);

    return profile;
  }

  async getUserProfile(uid) {
    if (!uid) return null;

    const snapshot = await getDoc(this.getUserRef(uid));

    if (!snapshot.exists()) return null;

    return {
      id: snapshot.id,
      ...snapshot.data()
    };
  }

  async updateUserProfile(uid, updates) {
    if (!uid) throw new Error("User ID is required.");

    const allowedUpdates = {
      ...updates,
      updatedAt: serverTimestamp()
    };

    await updateDoc(this.getUserRef(uid), allowedUpdates);

    return this.getUserProfile(uid);
  }

  async getCurrentUserProfile() {
    const user = auth.currentUser;

    if (!user) return null;

    return this.getUserProfile(user.uid);
  }

  async updateLastLogin(user) {
    if (!user?.uid) return;

    await updateDoc(this.getUserRef(user.uid), {
      lastLogin: serverTimestamp(),
      isEmailVerified: user.emailVerified
    });
  }

  async register({ fullName, email, password, phone = "" }) {
    const credential = await createUserWithEmailAndPassword(
      auth,
      email.trim(),
      password
    );

    await this.createUserProfile(credential.user, {
      fullName,
      phone
    });

    await sendEmailVerification(credential.user);

    await createActivityLog({
      action: "User Registered",
      userId: credential.user.uid
    });

    return credential.user;
  }

  async login({ email, password }) {
    const credential = await signInWithEmailAndPassword(
      auth,
      email.trim(),
      password
    );

    await this.updateLastLogin(credential.user);

    await createActivityLog({
      action: "User Logged In",
      userId: credential.user.uid
    });

    return credential.user;
  }

  async logout() {
    await signOut(auth);
    showToast("Logged out successfully.");
    this.redirectToLogin();
  }

  async forgotPassword(email) {
    await sendPasswordResetEmail(auth, email.trim());
  }

  async resendVerificationEmail() {
    const user = auth.currentUser;

    if (!user) {
      showToast("Please login first.", "error");
      return;
    }

    if (user.emailVerified) {
      showToast("Email is already verified.");
      return;
    }

    await sendEmailVerification(user);
    showToast("Verification email sent.");
  }

  renderUserSession(user, profile = null) {
    const nameTarget = qs("[data-user-name]");
    const emailTarget = qs("[data-user-email]");
    const roleTarget = qs("[data-user-role]");

    if (nameTarget) {
      nameTarget.textContent =
        profile?.fullName || user.email?.split("@")[0] || "User";
    }

    if (emailTarget) {
      emailTarget.textContent = user.email || "";
    }

    if (roleTarget) {
      roleTarget.textContent = profile?.role || "member";
    }
  }

  listenToAuthState() {
    onAuthStateChanged(auth, async (user) => {
      if (user && this.isAuthPage()) {
        this.redirectToDashboard();
        return;
      }

      if (!user && this.isProtectedPage()) {
        this.redirectToLogin();
        return;
      }

      if (user && this.isProtectedPage()) {
        await this.updateLastLogin(user).catch(console.error);

        const profile = await this.getUserProfile(user.uid);

        this.renderUserSession(user, profile);

        window.dispatchEvent(
          new CustomEvent("tripsplit:user-ready", {
            detail: {
              user,
              profile
            }
          })
        );
      }

      document.body.dataset.authReady = "true";
    });
  }

  bindRegisterForm() {
    const form = qs("#registerForm");
    if (!form) return;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      AuthValidator.clearErrors(form);

      const data = {
        fullName: form.fullName.value,
        email: form.email.value,
        password: form.password.value,
        phone: form.phone?.value || ""
      };

      const errors = AuthValidator.validateRegister(data);

      if (Object.keys(errors).length) {
        AuthValidator.renderErrors(errors);
        return;
      }

      const button = form.querySelector("button[type='submit']");
      button.disabled = true;
      button.textContent = "Creating Account...";

      try {
        await this.register(data);
        showToast("Account created. Verification email sent.");
        this.redirectToDashboard();
      } catch (error) {
        showToast(AuthErrorHandler.getMessage(error), "error");
      } finally {
        button.disabled = false;
        button.textContent = "Create Account";
      }
    });
  }

  bindLoginForm() {
    const form = qs("#loginForm");
    if (!form) return;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      AuthValidator.clearErrors(form);

      const data = {
        email: form.email.value,
        password: form.password.value
      };

      const errors = AuthValidator.validateLogin(data);

      if (Object.keys(errors).length) {
        AuthValidator.renderErrors(errors);
        return;
      }

      const button = form.querySelector("button[type='submit']");
      button.disabled = true;
      button.textContent = "Logging In...";

      try {
        await this.login(data);
        showToast("Login successful.");
        this.redirectToDashboard();
      } catch (error) {
        showToast(AuthErrorHandler.getMessage(error), "error");
      } finally {
        button.disabled = false;
        button.textContent = "Login";
      }
    });
  }

  bindForgotPasswordForm() {
    const form = qs("#forgotPasswordForm");
    if (!form) return;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      AuthValidator.clearErrors(form);

      const data = {
        email: form.email.value
      };

      const errors = AuthValidator.validateForgotPassword(data);

      if (Object.keys(errors).length) {
        AuthValidator.renderErrors(errors);
        return;
      }

      const button = form.querySelector("button[type='submit']");
      button.disabled = true;
      button.textContent = "Sending...";

      try {
        await this.forgotPassword(data.email);
        showToast("Password reset email sent.");
      } catch (error) {
        showToast(AuthErrorHandler.getMessage(error), "error");
      } finally {
        button.disabled = false;
        button.textContent = "Send Reset Link";
      }
    });
  }

  bindGlobalAuthActions() {
    document.addEventListener("click", async (event) => {
      const logoutButton = event.target.closest("[data-logout]");
      const verifyButton = event.target.closest("[data-resend-verification]");

      if (logoutButton) {
        event.preventDefault();

        try {
          await this.logout();
        } catch (error) {
          showToast(AuthErrorHandler.getMessage(error), "error");
        }
      }

      if (verifyButton) {
        event.preventDefault();

        try {
          await this.resendVerificationEmail();
        } catch (error) {
          showToast(AuthErrorHandler.getMessage(error), "error");
        }
      }
    });
  }

  init() {
    this.listenToAuthState();
    this.bindRegisterForm();
    this.bindLoginForm();
    this.bindForgotPasswordForm();
    this.bindGlobalAuthActions();
  }
}

const tripSplitAuth = new TripSplitAuthService();

document.addEventListener("DOMContentLoaded", () => {
  tripSplitAuth.init();
});

export {
  tripSplitAuth,
  createActivityLog
};

export const registerUser = (payload) => tripSplitAuth.register(payload);
export const loginUser = (payload) => tripSplitAuth.login(payload);
export const logoutUser = () => tripSplitAuth.logout();
export const getUserProfile = (uid) => tripSplitAuth.getUserProfile(uid);
export const updateUserProfile = (uid, updates) =>
  tripSplitAuth.updateUserProfile(uid, updates);
export const getCurrentUserProfile = () =>
  tripSplitAuth.getCurrentUserProfile();
export const resendVerificationEmail = () =>
  tripSplitAuth.resendVerificationEmail();
export const sendResetPasswordEmail = (email) =>
  tripSplitAuth.forgotPassword(email);