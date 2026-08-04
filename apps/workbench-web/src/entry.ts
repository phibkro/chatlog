import { Runtime } from "foldkit";

import { Model, init, subscriptions, update, view } from "./main";
import "./styles.css";

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  subscriptions,
  container: document.getElementById("root"),
});

const WORKBENCH_BOOTSTRAP_PREFIX = "#chatlog-workbench=";

function clearBootstrapFragment() {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

async function bootstrapWorkbench() {
  const fragment = window.location.hash;
  if (!fragment.startsWith(WORKBENCH_BOOTSTRAP_PREFIX)) return;
  const credential = fragment.slice(WORKBENCH_BOOTSTRAP_PREFIX.length);
  clearBootstrapFragment();
  if (!/^[A-Za-z0-9_-]+$/u.test(credential)) return;
  try {
    await fetch("/auth/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { Authorization: `Bearer ${credential}` },
    });
  } catch {
    // The regular API load reports an unavailable workbench without exposing credentials.
  }
}

void bootstrapWorkbench().then(() => Runtime.run(application));
