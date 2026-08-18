const COUNTER_ENDPOINT = "https://square-cake-5b98.kondou-masatoshi-074.workers.dev";

async function refreshPageViewCounter() {
  try {
    const response = await fetch(`${COUNTER_ENDPOINT}/count`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site: "main" }),
    });

    if (!response.ok) return;

    const stats = await response.json();
    document.querySelectorAll("[data-main-today]").forEach((node) => {
      node.textContent = Number(stats.today.main).toLocaleString();
    });
    document.querySelectorAll("[data-main-total]").forEach((node) => {
      node.textContent = Number(stats.allTime.main).toLocaleString();
    });
    document.querySelectorAll("[data-visit-counter]").forEach((node) => {
      node.hidden = false;
    });
  } catch {
    // The website remains fully usable if the optional counter is unavailable.
  }
}

refreshPageViewCounter();
