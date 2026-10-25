// Shapes crossing renderer ↔ main for app updates. The renderer only ever SHOWS this state
// and asks main to act; it never touches the network itself.

/** Where the update flow is. `checking.userStarted` tells the UI whether a failure is worth
 *  showing: a background check that fails stays quiet. */
export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking"; userStarted: boolean }
  | { kind: "none" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string; notes: string }
  | { kind: "error"; during: "check" | "download"; version?: string };

export interface UpdatesView {
  /** The running app's version (`app.getVersion()`), the one source every screen shows. */
  current: string;
  /** False in a dev build with no test feed: there is nothing to update from. */
  canUpdate: boolean;
  /** "Check for updates automatically" (on by default). */
  auto: boolean;
  state: UpdateState;
}
