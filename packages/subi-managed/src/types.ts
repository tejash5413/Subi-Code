export type LearnSmartRole = "student" | "teacher"
export type LearnSmartAccountType = "school" | "individual"

/** Identity display data only. Entitlements are fetched separately. */
export interface SafeLearnSmartUser {
  uid: string
  email: string
  displayName?: string
  role: LearnSmartRole
  accountType?: LearnSmartAccountType
  schoolId?: string
  studentId?: string
  teacherId?: string
}

export type SubiIdentity = { type: "guest" } | { type: "learnsmart"; user: SafeLearnSmartUser }
