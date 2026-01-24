// FUNDVISA - Contacto (público) - envío a Firestore + bloqueo inmediato + Toast profesional
import { db } from "./firebase.js";
import {
  addDoc, collection, serverTimestamp, doc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

(function initContact() {
  const form = document.getElementById("contactForm");
  if (!form) return;

  const btn = form.querySelector('button[type="submit"]');

  // --- Gate (config/contacto) ---
  const cfgRef = doc(db, "config", "contacto");
  let contactEnabled = true;
  let closedTitle = "Contacto temporalmente cerrado";
  let closedMsg = "Por el momento no estamos recibiendo mensajes por este medio. Intenta más tarde.";

  const ensureClosedBox = () => {
    let box = document.getElementById("fvContactClosed");
    if (!box) {
      box = document.createElement("div");
      box.id = "fvContactClosed";
      box.className = "alert alert-warning d-none mb-3";
      box.role = "alert";
      form.parentElement?.insertBefore(box, form);
    }
    return box;
  };

  const setFormEnabled = (on) => {
    form.querySelectorAll("input, textarea, select, button").forEach((el) => {
      // no rompas botones externos (si hay)
      if (el && typeof el.disabled === "boolean") el.disabled = !on;
    });
  };

  const applyGate = ({ enabled, title, msg }) => {
    contactEnabled = enabled !== false;
    if (typeof title === "string" && title.trim()) closedTitle = title.trim();
    if (typeof msg === "string" && msg.trim()) closedMsg = msg.trim();

    const box = ensureClosedBox();

    if (!contactEnabled) {
      box.classList.remove("d-none");
      box.innerHTML = `
        <div class="fw-bold mb-1">${escapeHtml(closedTitle)}</div>
        <div class="small">${escapeHtml(closedMsg)}</div>
      `;
      setFormEnabled(false);
    } else {
      box.classList.add("d-none");
      box.innerHTML = "";
      setFormEnabled(true);
    }
  };

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Realtime: bloqueo/desbloqueo sin recargar
  try {
    onSnapshot(cfgRef, (snap) => {
      if (snap.exists()) {
        const d = snap.data() || {};
        applyGate({
          enabled: d.enabled !== false,
          title: d.closedTitle,
          msg: d.closedMsg,
        });
      } else {
        applyGate({ enabled: true });
      }
    }, (err) => {
      // Si falla, no bloquees el sitio por error de lectura
      console.warn("No se pudo escuchar config/contacto:", err);
      applyGate({ enabled: true });
    });
  } catch (e) {
    console.warn("onSnapshot no disponible:", e);
  }

  // Toast Bootstrap (auto-crea contenedor) + fallback
  function toast(msg, type = "success", delay = 4200) {
    try {
      const bs = window.bootstrap;
      const map = { success: "success", danger: "danger", warning: "warning", info: "info", primary: "primary", secondary: "secondary" };
      const tone = map[type] || "primary";

      let wrap = document.getElementById("fvToastWrap");
      if (!wrap) {
        wrap = document.createElement("div");
        wrap.id = "fvToastWrap";
        wrap.className = "toast-container position-fixed bottom-0 end-0 p-3";
        wrap.style.zIndex = "1080";
        document.body.appendChild(wrap);
      }

      const el = document.createElement("div");
      el.className = `toast align-items-center text-bg-${tone} border-0 shadow`;
      el.role = "alert";
      el.ariaLive = "assertive";
      el.ariaAtomic = "true";
      el.innerHTML = `
        <div class="d-flex">
          <div class="toast-body">${escapeHtml(String(msg || ""))}</div>
          <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Cerrar"></button>
        </div>
      `;
      wrap.appendChild(el);

      if (bs && bs.Toast) {
        const t = new bs.Toast(el, { delay });
        el.addEventListener("hidden.bs.toast", () => el.remove());
        t.show();
      } else {
        alert(String(msg || ""));
        el.remove();
      }
    } catch {
      alert(String(msg || ""));
    }
  }

  const setBtnLoading = (on) => {
    if (!btn) return;
    if (on) {
      btn.disabled = true;
      btn.dataset._txt = btn.innerHTML;
      btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Enviando...`;
    } else {
      btn.disabled = false;
      btn.innerHTML = btn.dataset._txt || "Enviar Mensaje";
    }
  };

  const getVal = (...ids) => {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && typeof el.value === "string") return el.value.trim();
    }
    return "";
  };

  const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || "").trim());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (!contactEnabled) {
      toast(closedTitle || "Contacto temporalmente cerrado.", "warning");
      return;
    }

    const name = getVal("name", "nombre");
    const email = getVal("email", "correo");
    const phone = getVal("phone", "telefono");
    const subject = getVal("subject", "asunto");
    const message = getVal("message", "mensaje");

    if (!name || !email || !message) {
      toast("Completa los campos obligatorios: Nombre, Correo y Mensaje.", "warning");
      return;
    }
    if (!isEmail(email)) {
      toast("Revisa tu correo. Parece que no tiene un formato válido.", "warning");
      return;
    }

    const payload = {
      name,
      email: email.toLowerCase(),
      phone,
      subject,
      message,
      status: "new",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      source: "web_contacto",
    };

    try {
      setBtnLoading(true);
      await addDoc(collection(db, "contactMessages"), payload);

      toast("✅ ¡Mensaje enviado! Gracias por escribirnos. Te responderemos en 24–48 horas.", "success");
      form.reset();
    } catch (err) {
      console.error("Error al enviar contacto:", err);
      toast("No pudimos enviar el mensaje. Intenta nuevamente en unos minutos.", "danger");
    } finally {
      setBtnLoading(false);
    }
  });
})();
