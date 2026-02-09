const PREFERRED_DEVICE_STORAGE_KEY = "preferredAudioInputDeviceId";
const preferredKeywords = [
  "headset",
  "hands-free",
  "bluetooth",
  "airpods",
  "buds",
  "microphone",
  "mic",
];
const avoidKeywords = ["stereo mix", "virtual", "cable output", "monitor"];

function scoreAudioDevice(device) {
  const label = (device.label || "").toLowerCase();
  let score = 0;

  if (device.deviceId === "communications") score += 20;
  if (device.deviceId === "default") score += 10;
  if (preferredKeywords.some((keyword) => label.includes(keyword))) score += 25;
  if (label.includes("hands-free")) score += 10;
  if (avoidKeywords.some((keyword) => label.includes(keyword))) score -= 40;

  return score;
}

function getPreferredDeviceId() {
  try {
    return localStorage.getItem(PREFERRED_DEVICE_STORAGE_KEY);
  } catch (_error) {
    return null;
  }
}

function setPreferredDeviceId(deviceId) {
  try {
    localStorage.setItem(PREFERRED_DEVICE_STORAGE_KEY, deviceId);
  } catch (_error) {
    // Ignore storage failures.
  }
}

export async function chooseBestAudioInputDevice() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const audioInputDevices = devices.filter((device) => device.kind === "audioinput");
  if (!audioInputDevices.length) return null;

  const preferredDeviceId = getPreferredDeviceId();
  if (preferredDeviceId) {
    const preferredDevice = audioInputDevices.find(
      (device) => device.deviceId === preferredDeviceId
    );
    if (preferredDevice) return preferredDevice;
  }

  return audioInputDevices
    .slice()
    .sort((a, b) => scoreAudioDevice(b) - scoreAudioDevice(a))[0];
}

export async function listAudioDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === "audioinput");
}

export {
  getPreferredDeviceId,
  setPreferredDeviceId,
};
