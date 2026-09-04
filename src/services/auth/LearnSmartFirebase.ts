import { FirebaseApp, initializeApp, getApps, getApp } from 'firebase/app';
import { Auth, getAuth } from 'firebase/auth';
import { Firestore, getFirestore } from 'firebase/firestore';
import { LEARNSMART_FIREBASE_CONFIG, isLearnSmartFirebaseConfigured } from '../../config/learnsmartFirebase';

/**
 * Minimal LearnSmart Firebase bootstrap for the VS Code extension host
 * (Stage 4A.3). Initializes ONLY App + Auth + Firestore, lazily.
 *
 * Deliberately NOT initialized: Analytics, Storage, Messaging, Functions,
 * App Check / ReCaptchaEnterpriseProvider (browser-only), or anything
 * touching `window`. Direct Firestore reads of users/{uid} are permitted
 * for signed-in users by current LearnSmart Firestore rules, so no
 * App Check code is required here.
 */
export class LearnSmartFirebase {
  private app: FirebaseApp | undefined;
  private auth: Auth | undefined;
  private db: Firestore | undefined;

  private ensureConfigured(): void {
    if (!isLearnSmartFirebaseConfigured()) {
      throw new Error('LearnSmart sign-in is not configured.');
    }
  }

  getApp(): FirebaseApp {
    this.ensureConfigured();
    if (!this.app) {
      this.app = getApps().length > 0 ? getApp() : initializeApp({ ...LEARNSMART_FIREBASE_CONFIG });
    }
    return this.app;
  }

  getAuthInstance(): Auth {
    if (!this.auth) {
      this.auth = getAuth(this.getApp());
    }
    return this.auth;
  }

  getDb(): Firestore {
    if (!this.db) {
      this.db = getFirestore(this.getApp());
    }
    return this.db;
  }
}
