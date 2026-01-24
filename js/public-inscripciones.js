// FUNDVISA - Inscripciones (público) - Diseño Profesional
import { db } from "./firebase.js";
import { $, $$, cleanText, cleanEmail, cleanPhone, clampInt, toast, uid } from "./utils.js";
import {
  collection, doc, getDoc, getDocs, query, where, orderBy, limit, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";



async function gateInscripciones() {
  let cfg = { enabled: true, closedTitle: "Inscripciones cerradas", closedMsg: "Por el momento no tenemos convocatorias abiertas." };

  try {
    const snap = await getDoc(doc(db, "config", "inscripciones"));
    if (snap.exists()) {
      const d = snap.data() || {};
      cfg.enabled = d.enabled !== false;
      cfg.closedTitle = String(d.closedTitle || cfg.closedTitle);
      cfg.closedMsg = String(d.closedMsg || cfg.closedMsg);
    }
  } catch (e) {
    // si falla, no bloquees la página
    console.warn("No se pudo leer config/inscripciones", e);
  }

  if (!cfg.enabled) {
    // Cambia hero
    const titleEl = document.getElementById("fvInsTitle");
    const descEl = document.getElementById("fvInsDesc");
    if (titleEl) titleEl.textContent = cfg.closedTitle;
    if (descEl) descEl.textContent = cfg.closedMsg;

    // Oculta el card del formulario
    document.querySelector(".registration-card")?.classList.add("d-none");

    // Muestra el empty como “cerrado”
    const empty = document.getElementById("fvInsEmpty");
    if (empty) {
      empty.classList.remove("d-none");
      const h4 = empty.querySelector("h4");
      const p = empty.querySelector("p");
      if (h4) h4.textContent = cfg.closedTitle;
      if (p) p.textContent = cfg.closedMsg;
    }
    return false;
  }

  return true;
}

// Uso:
const ok = await gateInscripciones();
if (!ok) {
  // no cargues formularios
  // return;
}


(function initInscripciones() {
  const wrap = $("#fvInsWrap");
  const formEl = $("#fvInsForm");
  const loader = $("#fvInsLoader");
  const empty = $("#fvInsEmpty");
  const titleEl = $("#fvInsTitle");
  const descEl = $("#fvInsDesc");
  const selectEl = $("#fvInsSelect");

  if (!wrap || !formEl) return;

  let formsCache = [];
  let activeForm = null;

  // --- Paginación (tipo Google Forms) ---
  const PAGE_SIZE = 6; // preguntas por página
  let pagesFields = []; // Array<Array<field>>
  let currentPage = 0;
  let totalPages = 1;

  (async () => {
    try {
      loader?.classList.remove("d-none");

      // Trae formularios activos primero, luego fallback al más reciente
      const qActive = query(collection(db, "forms"), where("active", "==", true), orderBy("updatedAt", "desc"), limit(10));
      const snapActive = await getDocs(qActive);

      if (!snapActive.empty) {
        formsCache = snapActive.docs.map(d => ({ id: d.id, ...d.data() }));
      } else {
        const qLatest = query(collection(db, "forms"), orderBy("updatedAt", "desc"), limit(5));
        const snapLatest = await getDocs(qLatest);
        formsCache = snapLatest.docs.map(d => ({ id: d.id, ...d.data() }));
      }

      if (!formsCache.length) {
        empty?.classList.remove("d-none");
        if(selectEl) selectEl.innerHTML = '<option>Sin eventos disponibles</option>';
        return;
      }

      // Dropdown
      if (selectEl) {
        selectEl.innerHTML = formsCache.map((f, idx) => {
          const label = (f.title || `Evento ${idx + 1}`).slice(0, 80);
          return `<option value="${f.id}">${label}</option>`;
        }).join("");

        selectEl.addEventListener("change", () => selectForm(selectEl.value));
      }

      // activa el primero
      selectForm(formsCache[0].id);
    } catch (err) {
      console.error(err);
      toast("No se pudo cargar el formulario.", "danger");
    } finally {
      loader?.classList.add("d-none");
    }
  })();

  function selectForm(id) {
    activeForm = formsCache.find(f => f.id === id) || formsCache[0];
    if (!activeForm) return;

    // Actualiza el Hero Text también para dar contexto
    if (titleEl) titleEl.textContent = activeForm.title || "Inscripción";
    if (descEl) descEl.textContent = activeForm.desc || "Completa tus datos a continuación.";

    renderForm(activeForm);
  }

  function renderForm(f) {
    const fields = Array.isArray(f.fields) ? f.fields : [];
    if (!fields.length) {
      formEl.innerHTML = `
        <div class="text-center py-5">
            <i class="fas fa-clipboard-check fa-3x text-muted mb-3"></i>
            <p class="text-muted">Este formulario aún no tiene preguntas configuradas.</p>
        </div>`;
      return;
    }

    // Divide en páginas automáticamente
    pagesFields = chunkArray(fields, PAGE_SIZE);
    totalPages = Math.max(1, pagesFields.length);
    currentPage = 0;

    const pagesHtml = pagesFields.map((page, idx) => `
      <div class="fv-page ${idx === 0 ? "" : "d-none"}" data-fv-page="${idx}">
        ${page.map(renderField).join("")}
      </div>
    `).join("");

    formEl.innerHTML = `
      ${renderPagerTop()}
      <div id="fvInsPages">${pagesHtml}</div>
      ${renderPagerNav()}
      <p class="text-center text-muted small mt-3 mb-0">
        <i class="fas fa-lock me-1"></i> Tus datos están seguros con FUNDVISA.
      </p>
    `;

    wirePager();
    updatePagerUI();
  }

  function chunkArray(arr, size) {
    const s = Math.max(1, Number(size) || 6);
    const out = [];
    for (let i = 0; i < arr.length; i += s) out.push(arr.slice(i, i + s));
    return out;
  }

  function renderPagerTop() {
    const show = totalPages > 1;
    if (!show) return "";
    return `
      <div class="fv-pager-top" id="fvPagerTop">
        <span class="fv-step-pill" id="fvStepLabel">Página 1 de ${totalPages}</span>
        <div class="fv-progress">
          <div class="progress" role="progressbar" aria-label="Progreso del formulario">
            <div class="progress-bar bg-success" id="fvProgressBar" style="width:0%" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></div>
          </div>
        </div>
      </div>
    `;
  }

  function renderPagerNav() {
    const show = totalPages > 1;
    // Si solo hay 1 página, deja el botón enviar como antes (full width)
    if (!show) {
      return `
        <div class="mt-5 pt-3 border-top">
          <button class="btn btn-verde btn-submit-custom w-100" type="submit">
            <i class="fas fa-paper-plane me-2"></i> Confirmar Inscripción
          </button>
        </div>
      `;
    }

    return `
      <div class="fv-nav" id="fvPagerNav">
        <button class="btn btn-outline-secondary" type="button" id="fvPrevBtn">
          <i class="fas fa-arrow-left me-2"></i> Atrás
        </button>

        <div class="d-flex gap-2 ms-auto">
          <button class="btn btn-verde" type="button" id="fvNextBtn">
            Siguiente <i class="fas fa-arrow-right ms-2"></i>
          </button>

          <button class="btn btn-verde btn-submit-custom d-none" type="submit" id="fvSubmitBtn">
            <i class="fas fa-paper-plane me-2"></i> Enviar
          </button>
        </div>
      </div>
    `;
  }

  function wirePager() {
    const prev = formEl.querySelector("#fvPrevBtn");
    const next = formEl.querySelector("#fvNextBtn");

    prev?.addEventListener("click", () => {
      if (currentPage <= 0) return;
      showPage(currentPage - 1);
    });

    next?.addEventListener("click", () => {
      // Valida solo la página actual antes de avanzar
      if (!validatePage(currentPage)) {
        toast("Completa los campos obligatorios de esta página.", "warning");
        return;
      }
      if (currentPage >= totalPages - 1) return;
      showPage(currentPage + 1);
    });
  }

  function showPage(idx) {
    currentPage = Math.min(totalPages - 1, Math.max(0, idx));
    const pages = formEl.querySelectorAll('[data-fv-page]');
    pages.forEach(p => p.classList.add("d-none"));
    const active = formEl.querySelector(`[data-fv-page="${currentPage}"]`);
    active?.classList.remove("d-none");

    updatePagerUI();

    // Lleva al inicio del card (mejor UX)
    const top = document.getElementById("fvPagerTop") || formEl;
    top?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function updatePagerUI() {
    const show = totalPages > 1;
    if (!show) return;

    // Step label
    const step = formEl.querySelector("#fvStepLabel");
    if (step) step.textContent = `Página ${currentPage + 1} de ${totalPages}`;

    // Progress
    const pct = Math.round(((currentPage) / Math.max(1, (totalPages - 1))) * 100);
    const bar = formEl.querySelector("#fvProgressBar");
    if (bar) {
      bar.style.width = `${pct}%`;
      bar.setAttribute("aria-valuenow", String(pct));
    }

    // Buttons
    const prev = formEl.querySelector("#fvPrevBtn");
    const next = formEl.querySelector("#fvNextBtn");
    const submit = formEl.querySelector("#fvSubmitBtn");
    if (prev) prev.disabled = currentPage === 0;

    const last = currentPage === totalPages - 1;
    if (next) next.classList.toggle("d-none", last);
    if (submit) submit.classList.toggle("d-none", !last);
  }

  function validatePage(pageIdx) {
    // Limpia marcas anteriores en toda la página actual
    const pageEl = formEl.querySelector(`[data-fv-page="${pageIdx}"]`);
    if (!pageEl) return true;

    pageEl.querySelectorAll(".fv-field-invalid").forEach(el => el.classList.remove("fv-field-invalid"));

    const pageFields = pagesFields?.[pageIdx] || [];
    let firstBad = null;

    for (const field of pageFields) {
      const id = cleanText(field?.id || "", { max: 60, allowNewlines: false });
      const type = String(field?.type || "text");
      const required = !!field?.required;
      if (!required) continue;

      const name = `fv_${id}`;
      const inputs = $$(`[name="${CSS.escape(name)}"]`, formEl);

      let value = null;
      if (type === "multiselect" || type === "checkbox") {
        value = inputs.filter(i => i.checked).map(i => cleanText(i.value, { max: 80, allowNewlines: false }));
      } else if (type === "radio") {
        value = (inputs.find(i => i.checked)?.value) ?? "";
        value = cleanText(value, { max: 80, allowNewlines: false });
      } else {
        value = (inputs[0]?.value ?? "");
        if (type === "email") value = cleanEmail(value);
        else if (type === "phone") value = cleanPhone(value);
        else value = cleanText(value, { max: 2000, allowNewlines: type === "textarea" });
      }

      const emptyVal = Array.isArray(value) ? value.length === 0 : !value;
      if (emptyVal) {
        const wrap = pageEl.querySelector(`[data-fv-field="${CSS.escape(id)}"]`);
        if (wrap) {
          wrap.classList.add("fv-field-invalid");
          firstBad = firstBad || wrap;
        } else {
          firstBad = firstBad || inputs[0];
        }
      }
    }

    if (firstBad) {
      firstBad.scrollIntoView({ behavior: "smooth", block: "center" });
      return false;
    }
    return true;
  }

  function renderField(field) {
    const id = cleanText(field?.id || uid("f"), { max: 60, allowNewlines: false });
    const label = cleanText(field?.label || "Pregunta", { max: 120, allowNewlines: false });
    const help = cleanText(field?.help || "", { max: 200, allowNewlines: false });
    const type = String(field?.type || "text");
    const required = !!field?.required;
    const opts = Array.isArray(field?.options) ? field.options.map(o => cleanText(o, { max: 80, allowNewlines: false })).filter(Boolean) : [];

    const reqMark = required ? `<span class="text-danger" title="Requerido">*</span>` : "";
    const helpHtml = help ? `<div class="form-text ms-1"><i class="fas fa-info-circle me-1"></i>${help}</div>` : "";
    const name = `fv_${id}`;

    const labelHtml = `<label class="form-label">${label} ${reqMark}</label>`;

    // --- TEXTAREA ---
    if (type === "textarea") {
      return `
        <div class="mb-4 fv-field" data-fv-field="${id}">
          ${labelHtml}
          <textarea class="form-control" name="${name}" rows="4" ${required ? "required" : ""} maxlength="2000" placeholder="Escribe aquí..."></textarea>
          ${helpHtml}
        </div>
      `;
    }

    // --- EMAIL (Con icono) ---
    if (type === "email") {
      return `
        <div class="mb-4 fv-field" data-fv-field="${id}">
          ${labelHtml}
          <div class="input-group">
            <span class="input-group-text"><i class="fas fa-envelope"></i></span>
            <input class="form-control" type="email" name="${name}" ${required ? "required" : ""} maxlength="120" placeholder="ejemplo@correo.com" />
          </div>
          ${helpHtml}
        </div>
      `;
    }

    // --- TELEFONO (Con icono) ---
    if (type === "phone") {
      return `
        <div class="mb-4 fv-field" data-fv-field="${id}">
          ${labelHtml}
          <div class="input-group">
            <span class="input-group-text"><i class="fas fa-phone"></i></span>
            <input class="form-control" type="tel" name="${name}" ${required ? "required" : ""} maxlength="20" placeholder="Tu número de contacto" />
          </div>
          ${helpHtml}
        </div>
      `;
    }

    // --- NUMBER ---
    if (type === "number") {
      const min = clampInt(field?.min, { min: -999999, max: 999999, fallback: 0 });
      const max = clampInt(field?.max, { min: -999999, max: 999999, fallback: 999999 });
      return `
        <div class="mb-4 fv-field" data-fv-field="${id}">
          ${labelHtml}
          <input class="form-control" type="number" name="${name}" ${required ? "required" : ""} min="${min}" max="${max}" step="1" />
          ${helpHtml}
        </div>
      `;
    }

    // --- DATE ---
    if (type === "date") {
      return `
        <div class="mb-4 fv-field" data-fv-field="${id}">
          ${labelHtml}
          <div class="input-group">
             <span class="input-group-text"><i class="fas fa-calendar-alt"></i></span>
             <input class="form-control" type="date" name="${name}" ${required ? "required" : ""} />
          </div>
          ${helpHtml}
        </div>
      `;
    }

    // --- SELECT ---
    if (type === "select") {
      const optionsHtml = opts.map(o => `<option value="${o}">${o}</option>`).join("");
      return `
        <div class="mb-4 fv-field" data-fv-field="${id}">
          ${labelHtml}
          <select class="form-select" name="${name}" ${required ? "required" : ""}>
            <option value="">Selecciona una opción...</option>
            ${optionsHtml}
          </select>
          ${helpHtml}
        </div>
      `;
    }

    // --- RADIO ---
    if (type === "radio") {
      const radios = opts.map((o, idx) => `
        <div class="form-check mb-2">
          <input class="form-check-input" type="radio" name="${name}" id="${name}_${idx}" value="${o}" ${required ? "required" : ""}>
          <label class="form-check-label cursor-pointer" for="${name}_${idx}">${o}</label>
        </div>
      `).join("");
      return `<div class="mb-4 fv-field p-3 bg-light rounded border-start border-3 border-success">${labelHtml}${radios}${helpHtml}</div>`;
    }

    // --- CHECKBOX ---
    if (type === "multiselect" || type === "checkbox") {
      const checks = opts.map((o, idx) => `
        <div class="form-check mb-2">
          <input class="form-check-input" type="checkbox" name="${name}" id="${name}_${idx}" value="${o}">
          <label class="form-check-label cursor-pointer" for="${name}_${idx}">${o}</label>
        </div>
      `).join("");
      return `<div class="mb-4 fv-field p-3 bg-light rounded border-start border-3 border-success">${labelHtml}${checks}${helpHtml}</div>`;
    }

    // --- DEFAULT TEXT ---
    return `
      <div class="mb-4 fv-field" data-fv-field="${id}">
        ${labelHtml}
        <div class="input-group">
             <span class="input-group-text"><i class="fas fa-pen"></i></span>
             <input class="form-control" type="text" name="${name}" ${required ? "required" : ""} maxlength="250" />
        </div>
        ${helpHtml}
      </div>
    `;
  }

  const LS_KEY = "fv_ins_last_ts";
  const MIN_MS = 60_000;

  // Manejo del Submit (Lógica intacta)
  formEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!activeForm) return;

    const last = Number(localStorage.getItem(LS_KEY) || "0");
    if (Date.now() - last < MIN_MS) {
      toast("Espera un momento antes de enviar otra inscripción.", "warning");
      return;
    }

    const fields = Array.isArray(activeForm.fields) ? activeForm.fields : [];
    const answers = {};
    let valid = true;

    for (const field of fields) {
      const id = cleanText(field?.id || "", { max: 60, allowNewlines: false });
      const type = String(field?.type || "text");
      const required = !!field?.required;
      const name = `fv_${id}`;
      // Nota: querySelectorAll funciona igual aunque hayamos añadido divs extra
      const inputs = $$(`[name="${CSS.escape(name)}"]`, formEl);

      let value = null;

      if (type === "multiselect" || type === "checkbox") {
        value = inputs.filter(i => i.checked).map(i => cleanText(i.value, { max: 80, allowNewlines: false }));
      } else if (type === "radio") {
        value = (inputs.find(i => i.checked)?.value) ?? "";
        value = cleanText(value, { max: 80, allowNewlines: false });
      } else {
        value = (inputs[0]?.value ?? "");
        if (type === "email") value = cleanEmail(value);
        else if (type === "phone") value = cleanPhone(value);
        else value = cleanText(value, { max: 2000, allowNewlines: type === "textarea" });
      }

      const emptyVal = Array.isArray(value) ? value.length === 0 : !value;
      if (required && emptyVal) valid = false;

      answers[id] = value;
    }

    if (!valid) {
      toast("Completa los campos obligatorios marcados con *.", "warning");
      return;
    }

    const payload = {
      formId: activeForm.id,
      formTitle: cleanText(activeForm.title || "", { max: 120, allowNewlines: false }),
      answers,
      createdAt: serverTimestamp(),
      status: "new",
      meta: {
        page: window.location.pathname,
        ua: navigator.userAgent.slice(0, 180),
      },
    };

    const btn = formEl.querySelector('button[type="submit"]');

    try {
      if(btn) {
          btn.setAttribute("disabled", "disabled");
          btn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i> Enviando...';
      }
      
      await addDoc(collection(db, "formSubmissions"), payload);
      localStorage.setItem(LS_KEY, String(Date.now()));
      formEl.reset();
      
      // Feedback visual más claro
      formEl.innerHTML = `
        <div class="text-center py-5 animate__animated animate__fadeIn">
            <div class="mb-4 text-success">
                <i class="fas fa-check-circle fa-5x"></i>
            </div>
            <h3 class="fw-bold text-success mb-3">¡Inscripción Exitosa!</h3>
            <p class="lead text-muted">Gracias por registrarte. Hemos recibido tus datos correctamente.</p>
            <button class="btn btn-outline-success mt-3" onclick="location.reload()">Realizar otra inscripción</button>
        </div>
      `;
      
      toast("¡Inscripción enviada! Gracias por participar.", "success");
    } catch (err) {
      console.error(err);
      toast("No se pudo enviar la inscripción.", "danger");
      if(btn) {
          btn.removeAttribute("disabled");
          btn.innerHTML = '<i class="fas fa-paper-plane me-2"></i> Confirmar Inscripción';
      }
    }
  });
})();