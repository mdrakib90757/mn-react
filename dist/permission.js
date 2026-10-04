const btn = document.getElementById("grant-btn");
const statusBox = document.getElementById("status-box");

btn.addEventListener("click", async () => {
  try {
    btn.disabled = true;
    btn.textContent = "অনুমতি যাচাই হচ্ছে...";

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Stop immediately once access is granted
    stream.getTracks().forEach((track) => track.stop());

    statusBox.textContent = "অনুমতি সফলভাবে গ্রহণ করা হয়েছে! উইন্ডো বন্ধ হচ্ছে...";
    statusBox.className = "status success";

    // Inform runtime
    try {
      chrome.runtime.sendMessage({ type: "MIC_PERMISSION_GRANTED" });
    } catch {}

    setTimeout(() => {
      window.close();
    }, 1200);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "পুনরায় চেষ্টা করুন";
    statusBox.textContent = "মাইক্রোফোন অনুমতি দেওয়া হয়নি: " + (err.message || "Denied");
    statusBox.className = "status error";
  }
});

