// An HA scene's state is the ISO timestamp of its last activation. Reloading scenes (any
// scenes.yaml deploy) takes each one through unavailable and then RESTORES its previous
// timestamp — which looks exactly like an activation if you only check the new state.
//
// A real activation moves from one timestamp to another, or from 'unknown' for a scene's
// first ever use. Anything coming back from unavailable (or with no previous state) is a reload.
const isTimestamp = (state: string | undefined) => !!state && !Number.isNaN(Date.parse(state));

export function isSceneActivation(oldState: string | undefined, newState: string | undefined): boolean {
  if (!isTimestamp(newState)) return false;
  return isTimestamp(oldState) || oldState === 'unknown';
}
