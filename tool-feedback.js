(() => {
  "use strict";

  const ENDPOINT = "https://square-cake-5b98.kondou-masatoshi-074.workers.dev";
  const VALID_TOOLS = ["sspz", "presentation-timer", "school-bell"];

  function language() {
    return document.documentElement.lang.toLowerCase().startsWith("ja") ? "ja" : "en";
  }

  function formatCount(value) {
    return Number(value || 0).toLocaleString(language() === "ja" ? "ja-JP" : "en-US");
  }

  function storageKey(tool) {
    return `ct-lab-useful-${tool}-v1`;
  }

  function hasResponded(tool) {
    try {
      return localStorage.getItem(storageKey(tool)) === "1";
    } catch {
      return false;
    }
  }

  function rememberResponse(tool) {
    try {
      localStorage.setItem(storageKey(tool), "1");
    } catch {
      // The shared total still works when local storage is unavailable.
    }
  }

  function labels(responded = false) {
    if (language() === "ja") {
      return {
        button: responded ? "♥ 役に立ちました" : "♡ 役に立った",
        description: responded ? "ご協力ありがとうございます" : "このツールが役に立ったら押してください",
        countSuffix: "件",
      };
    }
    return {
      button: responded ? "♥ Useful" : "♡ Useful",
      description: responded ? "Thank you for your feedback" : "If this tool was useful, please let us know",
      countSuffix: "",
    };
  }

  function addStyles() {
    if (document.getElementById("ctLabFeedbackStyles")) return;
    const style = document.createElement("style");
    style.id = "ctLabFeedbackStyles";
    style.textContent = `
      .ctlab-feedback {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        width: min(calc(100% - 32px), 1100px);
        margin: 14px auto 22px;
        padding: 13px 16px;
        border: 1px solid rgba(33, 102, 172, 0.22);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.94);
        color: #33444f;
        box-shadow: 0 8px 24px rgba(20, 42, 54, 0.07);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans JP", "Yu Gothic", sans-serif;
      }
      .ctlab-feedback-copy {
        margin: 0;
        font-size: 0.88rem;
        line-height: 1.5;
      }
      .ctlab-feedback-button {
        flex: 0 0 auto;
        min-height: 44px;
        padding: 8px 16px;
        border: 1px solid #bf3563;
        border-radius: 999px;
        background: #fff;
        color: #a51f50;
        font: inherit;
        font-weight: 800;
        cursor: pointer;
      }
      .ctlab-feedback-button:hover {
        background: #fff0f5;
      }
      .ctlab-feedback-button[disabled] {
        border-color: #bf3563;
        background: #bf3563;
        color: #fff;
        cursor: default;
        opacity: 1;
      }
      .ctlab-feedback-count {
        display: inline-block;
        min-width: 1.2em;
        font-variant-numeric: tabular-nums;
      }
      .tool-feedback-summary {
        margin: 13px 0 0;
        color: inherit;
        font-size: 0.84rem;
        font-weight: 750;
        opacity: 0.82;
      }
      .tool-feedback-summary .feedback-heart {
        color: #ef7aa4;
      }
      @media (max-width: 560px) {
        .ctlab-feedback {
          align-items: stretch;
          flex-direction: column;
          width: min(calc(100% - 24px), 1100px);
        }
        .ctlab-feedback-button {
          width: 100%;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function updateAllCounts(data) {
    const likes = data?.likes || {};
    VALID_TOOLS.forEach((tool) => {
      document.querySelectorAll(`[data-tool-like-count="${tool}"]`).forEach((node) => {
        node.textContent = formatCount(likes[tool]);
      });
    });
  }

  function renderWidget(widget) {
    const tool = widget.dataset.tool;
    const responded = hasResponded(tool);
    const copy = labels(responded);
    const button = widget.querySelector(".ctlab-feedback-button");
    const description = widget.querySelector(".ctlab-feedback-description");
    if (button) {
      button.textContent = copy.button;
      button.disabled = responded;
      button.setAttribute("aria-pressed", responded ? "true" : "false");
    }
    if (description) description.textContent = copy.description;
  }

  function createWidget(tool) {
    const widget = document.createElement("aside");
    widget.className = "ctlab-feedback";
    widget.dataset.tool = tool;
    widget.setAttribute("aria-label", language() === "ja" ? "利用者からの評価" : "User feedback");
    widget.innerHTML = `
      <p class="ctlab-feedback-copy">
        <span class="ctlab-feedback-description"></span>
        · <strong><span class="ctlab-feedback-count" data-tool-like-count="${tool}">—</span></strong>
      </p>
      <button class="ctlab-feedback-button" type="button" aria-pressed="false"></button>
    `;

    const button = widget.querySelector(".ctlab-feedback-button");
    button.addEventListener("click", async () => {
      if (hasResponded(tool) || button.disabled) return;
      button.disabled = true;

      try {
        const response = await fetch(`${ENDPOINT}/like`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool }),
        });
        if (!response.ok) throw new Error("Feedback request failed");
        const data = await response.json();
        rememberResponse(tool);
        updateAllCounts(data);
        renderWidget(widget);
      } catch {
        button.disabled = false;
        button.textContent = language() === "ja" ? "再度お試しください" : "Please try again";
      }
    });

    renderWidget(widget);
    return widget;
  }

  async function loadCounts() {
    try {
      const response = await fetch(`${ENDPOINT}/likes`, { cache: "no-store" });
      if (!response.ok) return;
      updateAllCounts(await response.json());
    } catch {
      // Feedback is optional; the tools remain fully usable if it is unavailable.
    }
  }

  function initialize() {
    addStyles();

    const tool = document.body.dataset.toolFeedback;
    if (VALID_TOOLS.includes(tool)) {
      const banner = document.querySelector(".rights-banner");
      const widget = createWidget(tool);
      if (banner) banner.insertAdjacentElement("afterend", widget);
      else document.body.prepend(widget);

      new MutationObserver(() => renderWidget(widget)).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["lang"],
      });
    }

    loadCounts();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
