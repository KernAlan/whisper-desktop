export const STATES = Object.freeze({
  IDLE: "idle",
  ARMING: "arming",
  RECORDING: "recording",
  TRANSCRIBING: "transcribing",
  PASTING: "pasting",
  ERROR: "error",
});

export class RecorderStateMachine {
  constructor(onChange) {
    this.state = STATES.IDLE;
    this.onChange = typeof onChange === "function" ? onChange : () => {};
  }

  transition(next, detail = "") {
    const prev = this.state;
    this.state = next;
    this.onChange({ prev, next, detail });
  }

  getState() {
    return this.state;
  }

  canToggle() {
    return (
      this.state === STATES.IDLE ||
      this.state === STATES.RECORDING ||
      this.state === STATES.ERROR
    );
  }
}
