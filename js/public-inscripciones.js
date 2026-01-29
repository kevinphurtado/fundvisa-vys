// FUNDVISA - Inscripciones (público) - Diseño Profesional
import { db } from "./firebase.js";
import { $, $$, cleanText, cleanEmail, cleanPhone, clampInt, toast, uid } from "./utils.js";
import {
  collection, doc, getDoc, getDocs, query, where, orderBy, limit, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import {
  getStorage, ref as sRef, uploadBytes, getDownloadURL
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";

const storage = getStorage();


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

  // =============================================================
  // PAGO MANUAL (SIN BACKEND): Link de pago + comprobante
  // - Bloquea preguntas hasta subir comprobante.
  // - El botón de pago abre tu link de Mercado Pago (Checkout Pro Link / Link de pago).
  // =============================================================
  const PAY_LS_KEY = "fv_pay_state_v1";

  // ⚠️ REEMPLAZA mpLink por tus 4 links reales de Mercado Pago
  // (ej: https://mpago.la/XXXXXX)
  const PAY_PLANS = [
    { code: "GENERAL_ST", label: "Plan General - Sin transporte", amount: 80000, mpLink: "https://mpago.li/15Xi7NF" },
    { code: "GENERAL_CT", label: "Plan General - Con transporte", amount: 95000, mpLink: "https://mpago.li/15Xi7NF" },
    { code: "DESAFIO_ST", label: "Plan Desafío - Sin transporte", amount: 90000, mpLink: "https://mpago.li/15Xi7NF" },
    { code: "DESAFIO_CT", label: "Plan Desafío - Con transporte", amount: 105000, mpLink: "https://mpago.li/15Xi7NF" },
  ];

  function loadPayState() {
    try { return JSON.parse(localStorage.getItem(PAY_LS_KEY) || "null"); } catch { return null; }
  }
  function savePayState(x) {
    try { localStorage.setItem(PAY_LS_KEY, JSON.stringify(x)); } catch { /* ignore */ }
  }
  function clearPayState() {
    try { localStorage.removeItem(PAY_LS_KEY); } catch { /* ignore */ }
  }

  function freshPayState(formId) {
    return {
      payId: uid("pay"),
      formId: String(formId || ""),
      planCode: "",
      planLabel: "",
      amount: 0,
      mpLink: "",
      clickedPay: false,
      proof: { url: "", storagePath: "", fileName: "", uploadedAt: 0 },
      unlocked: false
    };
  }

  let payState = loadPayState() || freshPayState("");



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

    // ELIMINAR O COMENTAR ESTE BLOQUE:
    /* if (!payState?.unlocked || !payState?.proof?.url) {
      toast("Debes subir el comprobante de pago para poder enviar la inscripción.", "warning");
      return;
    }
    */

    // Si el usuario cambia de evento, reinicia el flujo de pago
    if (!payState || String(payState.formId || "") !== String(activeForm.id || "")) {
      payState = freshPayState(activeForm.id);
      savePayState(payState);
    }

    // Actualiza el Hero Text
    if (titleEl) titleEl.textContent = activeForm.title || "Inscripción";
    if (descEl) descEl.textContent = activeForm.desc || "Completa tus datos a continuación.";

    // Renderiza siempre (el renderForm se encarga de mostrar/ocultar según el estado)
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
      ${renderPaymentGate()}
      <div id="fvQuestionsWrap" class="${payState.unlocked ? "" : "d-none"}">
        ${renderPagerTop()}
        <div id="fvInsPages">${pagesHtml}</div>
        ${renderPagerNav()}
        <p class="text-center text-muted small mt-3 mb-0">
          <i class="fas fa-lock me-1"></i> Tus datos están seguros con FUNDVISA.
        </p>
      </div>
    `;

    wirePaymentGate();
    wirePager();
    if (payState.unlocked) updatePagerUI();
  }

  function renderPaymentGate() {
    const opts = PAY_PLANS.map(p => `
      <option value="${p.code}" ${p.code === payState.planCode ? "selected" : ""}>
        ${p.label} ($${p.amount.toLocaleString("es-CO")})
      </option>
    `).join("");

    const hasLink = !!payState?.mpLink;
    const proofOk = !!payState?.proof?.url;
    const isCollapsed = proofOk; //  cuando ya hay comprobante, colapsa por defecto

    return `
      <div class="mb-4">
        <div class="border rounded-4 overflow-hidden bg-white shadow-sm">
          <!-- Header -->
          <div class="p-3 p-md-4 d-flex align-items-start justify-content-between gap-3"
              style="background: linear-gradient(180deg, rgba(13,110,253,.08), rgba(25,135,84,.04));">
            <div class="pe-2">
              <div class="d-flex align-items-center gap-2">
                <div class="fw-bold text-dark fs-5">Pago e Inscripción</div>
                <span class="badge ${payState.unlocked ? "text-bg-success" : "text-bg-secondary"}">
                  ${payState.unlocked ? "Habilitado" : "Bloqueado"}
                </span>
              </div>
              <div class="small text-muted mt-1">
                1) Elige tu plan • 2) Paga en Mercado Pago • 3) Sube el comprobante para continuar.
              </div>
            </div>

            <!-- Toggle (aparece cuando ya subió comprobante) -->
            <button type="button"
                    class="btn btn-sm ${proofOk ? "btn-outline-success" : "btn-outline-secondary"}"
                    id="fvPayToggle"
                    ${proofOk ? "" : "disabled"}
                    aria-expanded="${isCollapsed ? "false" : "true"}"
                    aria-controls="fvPayBody">
              <i class="fas ${isCollapsed ? "fa-chevron-down" : "fa-chevron-up"} me-2"></i>
              ${isCollapsed ? "Ver pago" : "Ocultar"}
            </button>
          </div>

          <!-- Body -->
          <div id="fvPayBody" class="p-3 p-md-4 ${isCollapsed ? "d-none" : ""}">
            <div class="row g-3 align-items-end">
              <div class="col-12">
                <label class="form-label mb-1">Plan</label>
                <select class="form-select" id="fvPayPlan" ${payState.unlocked ? "disabled" : ""}>
                  <option value="">Selecciona un plan...</option>
                  ${opts}
                </select>
              </div>

              <div class="col-12 col-md-7">
                <div class="small text-muted mb-1">Total</div>
                <div class="d-flex align-items-baseline gap-2">
                  <div class="fs-3 fw-bold" id="fvPayAmount">
                    $${Number(payState.amount || 0).toLocaleString("es-CO")}
                  </div>
                  <span class="small text-muted">COP</span>
                </div>
              </div>

              <div class="col-12 col-md-5 d-grid">
                <a id="fvPayBtn"
                  class="btn btn-primary ${hasLink ? "" : "disabled"}"
                  href="${hasLink ? payState.mpLink : "#"}"
                  target="_blank" rel="noopener">
                  <i class="fas fa-credit-card me-2"></i> Pagar en Mercado Pago
                </a>
              </div>

              <!-- Uploader -->
              <div class="col-12">
                <div class="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-1">
                  <label class="form-label mb-0">Comprobante</label>
                  <span class="badge ${proofOk ? "text-bg-success" : "text-bg-warning"}">
                    ${proofOk ? "Cargado" : "Pendiente"}
                  </span>
                </div>

                <div class="border rounded-3 p-3 bg-light">
                  <div class="row g-2 align-items-center">
                    <div class="col-12 col-md">
                      <input class="form-control"
                            type="file"
                            id="fvPayProof"
                            accept="image/*,application/pdf"
                            ${payState.unlocked ? "disabled" : ""} />
                      <div class="form-text mt-2">
                        Máx. 8MB. Formatos: imagen o PDF.
                      </div>
                    </div>

                    <div class="col-12 col-md-auto d-grid">
                      <button type="button"
                              class="btn btn-success"
                              id="fvPayUpload"
                              ${proofOk ? "disabled" : ""}>
                        <i class="fas fa-upload me-2"></i> Subir y habilitar
                      </button>
                    </div>
                  </div>

                  ${proofOk ? `
                    <div class="mt-3 p-2 rounded-3 bg-white border d-flex align-items-center justify-content-between flex-wrap gap-2">
                      <div class="small text-muted">
                        <i class="fas fa-check-circle text-success me-2"></i>
                        Comprobante cargado. Puedes continuar con la inscripción.
                      </div>
                      <a class="btn btn-sm btn-outline-secondary" href="${payState.proof.url}" target="_blank" rel="noopener">
                        <i class="fas fa-receipt me-2"></i> Ver comprobante
                      </a>
                    </div>
                  ` : `
                    <div class="mt-3 small text-muted">
                      <i class="fas fa-info-circle me-2"></i>
                      Después de pagar, vuelve aquí y sube el comprobante para desbloquear el formulario.
                    </div>
                  `}
                </div>
              </div>

              <!-- Actions -->
              <div class="col-12 d-grid d-md-flex justify-content-md-end gap-2 mt-1">
                <button type="button" class="btn btn-outline-secondary" id="fvPayReset">
                  <i class="fas fa-rotate-left me-2"></i> Reiniciar pago
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Mini bar cuando está colapsado -->
        ${proofOk ? `
          <div id="fvPayMini"
              class="mt-2 border rounded-4 p-2 px-3 bg-white shadow-sm d-flex align-items-center justify-content-between gap-2">
            <div class="small text-muted">
              <i class="fas fa-lock-open text-success me-2"></i>
              Pago verificado manualmente: <b>${payState.planLabel || payState.planCode || "Plan"}</b> •
              <b>$${Number(payState.amount || 0).toLocaleString("es-CO")}</b>
            </div>
            <button type="button" class="btn btn-sm btn-outline-secondary" id="fvPayToggleMini">
              <i class="fas fa-chevron-down me-2"></i> Ver
            </button>
          </div>
        ` : ""}
      </div>
    `;
  }


  function wirePaymentGate() {
    const planSel = formEl.querySelector("#fvPayPlan");
    const payBtn  = formEl.querySelector("#fvPayBtn");
    const amount  = formEl.querySelector("#fvPayAmount");
    const proofIn = formEl.querySelector("#fvPayProof");
    const upBtn   = formEl.querySelector("#fvPayUpload");
    const resetBtn= formEl.querySelector("#fvPayReset");

    function setPlan(code) {
      const p = PAY_PLANS.find(x => x.code === code);
      if (!p) {
        payState.planCode = "";
        payState.planLabel = "";
        payState.amount = 0;
        payState.mpLink = "";
        payState.clickedPay = false;
        savePayState(payState);
        amount && (amount.textContent = "$0");
        if (payBtn) {
          payBtn.classList.add("disabled");
          payBtn.href = "#";
        }
        return;
      }

      payState.planCode = p.code;
      payState.planLabel = p.label;
      payState.amount = p.amount;
      payState.mpLink = p.mpLink;
      payState.clickedPay = false;
      savePayState(payState);

      amount && (amount.textContent = `$${p.amount.toLocaleString("es-CO")}`);
      if (payBtn) {
        const has = !!p.mpLink;
        payBtn.classList.toggle("disabled", !has);
        payBtn.href = has ? p.mpLink : "#";
      }
    }

    // Estado inicial
    if (amount) amount.textContent = `$${Number(payState.amount || 0).toLocaleString("es-CO")}`;
    if (payBtn) payBtn.href = payState.mpLink || "#";

    planSel?.addEventListener("change", () => setPlan(String(planSel.value || "")));

    payBtn?.addEventListener("click", () => {
      if (!payState.planCode) {
        toast("Selecciona un plan primero.", "warning");
        return;
      }
      if (!payState.mpLink) {
        toast("Este plan no tiene link de pago configurado.", "warning");
        return;
      }
      payState.clickedPay = true;
      savePayState(payState);
    });

    // Toggle body/mini
    const payBody = formEl.querySelector("#fvPayBody");
    const payMini = formEl.querySelector("#fvPayMini");
    const toggleBtn = formEl.querySelector("#fvPayToggle");
    const toggleMiniBtn = formEl.querySelector("#fvPayToggleMini");

    function setPayCollapsed(collapsed) {
      if (!payBody) return;

      payBody.classList.toggle("d-none", collapsed);

      // si existe mini-bar, se muestra solo cuando está colapsado
      if (payMini) payMini.classList.toggle("d-none", !collapsed);

      // Actualiza botón principal (si existe)
      if (toggleBtn) {
        toggleBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");

        const icon = toggleBtn.querySelector("i");
        if (icon) {
          icon.classList.toggle("fa-chevron-down", collapsed);
          icon.classList.toggle("fa-chevron-up", !collapsed);
        }

        // texto del botón (sin romper el icono)
        toggleBtn.lastChild.textContent = collapsed ? " Ver pago" : " Ocultar";
      }

      // Actualiza botón mini (si existe)
      if (toggleMiniBtn) {
        const icon2 = toggleMiniBtn.querySelector("i");
        if (icon2) {
          icon2.classList.toggle("fa-chevron-down", collapsed);
          icon2.classList.toggle("fa-chevron-up", !collapsed);
        }
        toggleMiniBtn.lastChild.textContent = collapsed ? " Ver" : " Ocultar";
      }
    }

    // estado inicial: colapsa si ya hay comprobante (como tu render lo define)
    setPayCollapsed(!!payState?.proof?.url);

    // clicks
    toggleBtn?.addEventListener("click", () => {
      // si está colapsado => expandir; si está expandido => colapsar
      const collapsed = payBody?.classList.contains("d-none");
      setPayCollapsed(!collapsed ? true : false);
    });

    toggleMiniBtn?.addEventListener("click", () => {
      setPayCollapsed(false);
    });

    resetBtn?.addEventListener("click", () => {
      // reinicia flujo del mismo evento
      payState = freshPayState(activeForm?.id || "");
      savePayState(payState);
      renderForm(activeForm);
    });

    upBtn?.addEventListener("click", async () => {
      if (payState.unlocked) return;

      if (!payState.planCode) return toast("Selecciona un plan.", "warning");
      if (!payState.mpLink) return toast("Falta configurar el link de pago de este plan.", "warning");

      // Recomendado: exigir que haya abierto el link (mínimo control)
      if (!payState.clickedPay) {
        toast("Primero haz clic en “Ir a pagar”, luego vuelve y sube el comprobante.", "warning");
        return;
      }

      const file = proofIn?.files?.[0] || null;
      if (!file) return toast("Adjunta tu comprobante (imagen o PDF).", "warning");

      const max = 8 * 1024 * 1024;
      if (file.size > max) return toast("El archivo supera 8MB.", "warning");

      const isImg = String(file.type || "").startsWith("image/");
      const isPdf = file.type === "application/pdf";
      if (!isImg && !isPdf) return toast("Formato no válido. Usa imagen o PDF.", "warning");

      try {
        upBtn.setAttribute("disabled", "disabled");
        upBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i> Subiendo...';

        const ext = (file.name.split(".").pop() || (isImg ? "jpg" : "pdf")).toLowerCase().slice(0, 6);
        const year = new Date().getFullYear();
        const formId = String(activeForm?.id || payState.formId || "form");
        const storagePath = `comprobantes/${year}/${formId}/${payState.payId}.${ext}`;
        const r = sRef(storage, storagePath);

        await uploadBytes(r, file, { contentType: file.type || "" });
        const url = await getDownloadURL(r);

        payState.formId = formId;
        payState.proof = {
          url,
          storagePath,
          fileName: String(file.name || "").slice(0, 120),
          uploadedAt: Date.now()
        };
        payState.unlocked = true;
        savePayState(payState);

        // Habilita preguntas
        formEl.querySelector("#fvQuestionsWrap")?.classList.remove("d-none");
        updatePagerUI();
        toast("Comprobante cargado. Ya puedes continuar.", "success");

        // re-render para que el badge cambie a "habilitado"
        renderForm(activeForm);
      } catch (e) {
        console.error(e);
        toast("No se pudo subir el comprobante.", "danger");
        upBtn.removeAttribute("disabled");
        upBtn.innerHTML = '<i class="fas fa-upload me-2"></i> Subir comprobante y continuar';
      }
    });
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
  
      payment: {
        payId: payState.payId,
        planCode: payState.planCode,
        planLabel: payState.planLabel,
        amount: payState.amount,
        mpLink: payState.mpLink,
        proofUrl: payState.proof.url,
        proofStoragePath: payState.proof.storagePath,
        proofFileName: payState.proof.fileName,
        proofUploadedAt: payState.proof.uploadedAt,
        verification: "pending"
      }
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
      clearPayState();
      
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