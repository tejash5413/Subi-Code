// The managed account contract only. Tool execution belongs to OpenCode.
export type PermissionProfileName = "ask" | "session" | "full"

export interface ManagedPermissionPolicy {
  schemaVersion: 1
  profileCeiling: PermissionProfileName
  source: "school_role" | "individual"
  validUntilMs: number
}
