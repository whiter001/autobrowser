const STORAGE_KEY = "autobrowserToken";

async function loadToken() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  document.getElementById("token").value = result[STORAGE_KEY] || "";
}

async function saveToken() {
  const token = document.getElementById("token").value.trim();
  await chrome.storage.local.set({ [STORAGE_KEY]: token });
  document.getElementById("status").textContent = token ? "已保存，扩展会自动重连" : "已清空";
}

document.getElementById("save").addEventListener("click", () => {
  saveToken().catch((error) => {
    document.getElementById("status").textContent = error.message;
  });
});

loadToken().catch((error) => {
  document.getElementById("status").textContent = error.message;
});
