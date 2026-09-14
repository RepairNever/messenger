export interface SoundEngine {
  playMessagePing(): Promise<void>
  playCallMemberJoined(): Promise<void>
  playCallMemberLeft(): Promise<void>
  startCallInviteRing(): Promise<void>
  stopCallInviteRing(): void
  dispose(): void
}
