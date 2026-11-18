// The end of an approval sign-in in a popup: tell the page that opened it,
// on this origin only, and close. Google's page can cut the link to the
// opener, so a broadcast channel carries the message too.
(function () {
  var action = new URLSearchParams(window.location.search).get("action") || "";
  var message = { kind: "satyr:approval-signed-in", action: action };
  try {
    var channel = new BroadcastChannel("satyr-approval-sign-in");
    channel.postMessage(message);
    channel.close();
  } catch (error) {}
  try {
    if (window.opener) window.opener.postMessage(message, window.location.origin);
  } catch (error) {}
  window.setTimeout(function () { window.close(); }, 150);
})();
