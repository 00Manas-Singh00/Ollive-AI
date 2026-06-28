(function () {
  var script = document.currentScript;
  var token = script.getAttribute("data-token");
  var baseUrl = script.getAttribute("data-base-url") || new URL(script.src).origin;
  if (!token) {
    console.error("[OlliveAI embed] data-token attribute is required");
    return;
  }

  var width = script.getAttribute("data-width") || "360px";
  var height = script.getAttribute("data-height") || "520px";

  var iframe = document.createElement("iframe");
  iframe.src = baseUrl + "/embed/" + token;
  iframe.style.position = "fixed";
  iframe.style.bottom = "20px";
  iframe.style.right = "20px";
  iframe.style.width = width;
  iframe.style.height = height;
  iframe.style.border = "1px solid rgba(0,0,0,0.1)";
  iframe.style.borderRadius = "12px";
  iframe.style.boxShadow = "0 8px 30px rgba(0,0,0,0.18)";
  iframe.style.zIndex = "999999";
  iframe.title = "OlliveAI Chat";

  document.body.appendChild(iframe);
})();
