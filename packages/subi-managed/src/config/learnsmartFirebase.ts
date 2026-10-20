/**
 * LearnSmart Firebase WEB CLIENT configuration (Stage 4A.3).
 *
 * These six values are public Firebase client identifiers (the same values
 * shipped inside the LearnSmart website bundle). They are NOT secrets and
 * must never be confused with AI provider API keys in SecretStorage.
 *
 * Do NOT place here: Firebase Admin credentials, service-account JSON,
 * private keys, App Check debug tokens, reCAPTCHA secrets, or any
 * AI provider API keys.
 */
export interface LearnSmartFirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}

export const LEARNSMART_FIREBASE_CONFIG: LearnSmartFirebaseConfig = {
  apiKey: 'AIzaSyBDctKKV-vow3qXrFJihaFvzbt-QEsovJg',
  authDomain: 'stlearnsmart.in',
  projectId: 'learnsmart-c2a7e',
  storageBucket: 'photos-oysi5',
  messagingSenderId: '735353248164',
  appId: '1:735353248164:web:39dd665341734b3ef80931',
};

export function isLearnSmartFirebaseConfigured(): boolean {
  const c = LEARNSMART_FIREBASE_CONFIG;
  return (
    c.apiKey.trim().length > 0 &&
    c.authDomain.trim().length > 0 &&
    c.projectId.trim().length > 0 &&
    c.storageBucket.trim().length > 0 &&
    c.messagingSenderId.trim().length > 0 &&
    c.appId.trim().length > 0
  );
}
