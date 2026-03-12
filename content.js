let throttle = null;

function notifyActivity() {
  if (throttle) return;
  throttle = setTimeout(() => { throttle = null; }, 500);
  try {
    chrome.runtime.sendMessage({ action: 'userActivity' });
  } catch (e) {}
}

document.addEventListener('mousemove', notifyActivity, { passive: true });
document.addEventListener('mousedown', notifyActivity, { passive: true });
document.addEventListener('wheel', notifyActivity, { passive: true });
document.addEventListener('keydown', notifyActivity, { passive: true });
document.addEventListener('touchstart', notifyActivity, { passive: true });
document.addEventListener('touchmove', notifyActivity, { passive: true });
document.addEventListener('scroll', notifyActivity, { passive: true });
