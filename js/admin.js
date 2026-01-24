// FUNDVISA - Admin (seguro, validado y con paginación)
import { auth, db, storage } from "./firebase.js";
import {
  $, $$, cleanText, cleanEmail, cleanPhone, cleanUrl, clampInt, uid,
  toast, exportToXlsx, fmtDate
} from "./utils.js";

import {
  collection, addDoc, deleteDoc, doc, getDoc, getDocs, updateDoc, setDoc,
  query, where, orderBy, limit, startAfter, serverTimestamp, writeBatch, increment
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import {
  ref, uploadBytesResumable, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";

/** ========================================================================
 *  CONFIG (IMPORTANTE)
 *  - Reemplaza por tus correos admin.
 *  - Deben coincidir con las reglas firestore.rules / storage.rules.
 *  ======================================================================== */
const ADMIN_EMAILS = [
  "kevin.phurtado@gmail.com",
  // "otroadmin@correo.com",
];

const MAX_IMG_MB = 4;
const PAGE_SIZE = 20;

/** ========================================================================
 *  State
 *  ======================================================================== */
let currentUser = null;

// Gallery
let galleryCursor = null;
let galleryLoaded = 0;

// Contacts
let contactsCursor = null;
let contactsLoaded = 0;
let contactsFilter = "new";
let openContactId = null;

// Forms + Fields
let formsCache = [];
let selectedFormId = null;
let selectedFieldsDraft = [];
let fieldModal = null;

// Submissions
let subsCursor = null;
let subsLoaded = 0;
let subsFilter = "new";
let subsFormFilter = "all";
let openSubId = null;

// Projects
let projectsCursor = null;
let projectsLoaded = 0;

/** ========================================================================
 *  Helpers
 *  ======================================================================== */
function isAdminEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return ADMIN_EMAILS.map(x => x.toLowerCase()).includes(e);
}

function setProgress(el, pct) {
  if (!el) return;
  const bar = el.querySelector(".progress-bar");
  if (bar) bar.style.width = `${pct}%`;
}

function fileOk(file) {
  if (!file) return { ok: false, reason: "No se seleccionó archivo." };
  if (!file.type.startsWith("image/")) return { ok: false, reason: "El archivo debe ser una imagen." };
  const mb = file.size / (1024 * 1024);
  if (mb > MAX_IMG_MB) return { ok: false, reason: `Máximo ${MAX_IMG_MB} MB. Este archivo pesa ${mb.toFixed(2)} MB.` };
  return { ok: true };
}

function statusBadge(status, map) {
  const m = map || {
    new: ["Nuevo", "text-bg-warning"],
    read: ["Leído", "text-bg-primary"],
    archived: ["Archivado", "text-bg-secondary"],
    reviewed: ["Revisada", "text-bg-primary"],
  };
  const [label, cls] = m[status] || ["—", "text-bg-light"];
  return `<span class="badge ${cls}">${label}</span>`;
}

// Cache para mapear IDs de preguntas (q_...) -> etiqueta humana
const formMetaCache = new Map(); // formId -> { title, labelById, orderById }

async function getFormMeta(formId) {
  const id = String(formId || "").trim();
  if (!id) return null;
  if (formMetaCache.has(id)) return formMetaCache.get(id);

  const meta = { title: "", labelById: {}, orderById: {} };

  try {
    const snap = await getDoc(doc(db, "forms", id));
    if (snap.exists()) {
      const d = snap.data() || {};
      meta.title = String(d.title || "");
      const fields = Array.isArray(d.fields) ? d.fields : [];
      fields.forEach((f, idx) => {
        const fid = String(f?.id || "").trim();
        if (!fid) return;
        meta.labelById[fid] = String(f?.label || fid);
        meta.orderById[fid] = idx;
      });
    }
  } catch (e) {
    // No bloquear el admin si faltan reglas
    console.warn("No se pudo leer forms para mapear etiquetas:", e);
  }

  formMetaCache.set(id, meta);
  return meta;
}

function answerToText(v) {
  if (Array.isArray(v)) return v.map(x => String(x ?? "")).filter(Boolean).join(", ");
  if (v && typeof v === "object") {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v ?? "");
}

function orderedAnswerKeys(answers, meta) {
  const keys = Object.keys(answers || {});
  if (!meta || !meta.orderById) return keys;
  return keys.sort((a, b) => {
    const ai = meta.orderById[a];
    const bi = meta.orderById[b];
    const A = Number.isFinite(ai) ? ai : 9999;
    const B = Number.isFinite(bi) ? bi : 9999;
    if (A !== B) return A - B;
    return String(a).localeCompare(String(b));
  });
}

/** ========================================================================
 *  Auth UI
 *  ======================================================================== */
const loginView = $("#loginView");
const appView = $("#appView");
const btnLogout = $("#btnLogout");
const btnRefresh = $("#btnRefresh");
const btnExportAll = $("#btnExportAll");
const userEmailEl = $("#userEmail");
const loginHint = $("#loginHint");
// --- Login guard (anti brute-force básico en el navegador) ---
const LS_LOGIN_GUARD = "fv_admin_login_guard_v1";
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 30_000;

function readLoginGuard() {
  try { return JSON.parse(localStorage.getItem(LS_LOGIN_GUARD) || "{}"); } catch { return {}; }
}
function writeLoginGuard(obj) {
  try { localStorage.setItem(LS_LOGIN_GUARD, JSON.stringify(obj || {})); } catch { /* ignore */ }
}
function canAttemptLogin() {
  const g = readLoginGuard();
  const until = Number(g.lockUntil || 0);
  return !(until && Date.now() < until);
}
function loginLockMessage() {
  const g = readLoginGuard();
  const until = Number(g.lockUntil || 0);
  if (!until) return "Intenta de nuevo.";
  const secs = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  return `Demasiados intentos. Intenta nuevamente en ${secs}s.`;
}
function recordLoginFail() {
  const g = readLoginGuard();
  const fails = Number(g.fails || 0) + 1;
  const next = { fails };
  if (fails >= LOGIN_MAX_FAILS) {
    next.lockUntil = Date.now() + LOGIN_LOCK_MS;
  }
  writeLoginGuard(next);
}

function recordLoginSuccess() {
  writeLoginGuard({ fails: 0, lockUntil: 0 });
}


$("#loginForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!canAttemptLogin()) {
    showLoginHint(loginLockMessage());
    return;
  }

  const email = cleanEmail($("#loginEmail")?.value);
  const pass = String($("#loginPass")?.value || "");

  if (!email || pass.length < 6) {
    showLoginHint("Revisa el correo y la contraseña.");
    return;
  }

  try {
    await signInWithEmailAndPassword(auth, email, pass);
    recordLoginSuccess();
  } catch (err) {
    console.error(err);
    recordLoginFail();
    showLoginHint(canAttemptLogin()
      ? "No se pudo iniciar sesión. Verifica credenciales."
      : loginLockMessage()
    );
  }
});


$("#btnCreateAdmin")?.addEventListener("click", async () => {
  // Importante: bloquear creación de cuentas si NO hay un admin autenticado.
  if (!currentUser || !isAdminEmail(currentUser.email || "")) {
    showLoginHint("Primero inicia sesión como admin para crear otro usuario.");
    return;
  }

  const email = cleanEmail($("#loginEmail")?.value);
  const pass = String($("#loginPass")?.value || "");

  if (!email || pass.length < 6) {
    showLoginHint("Para crear usuario: escribe correo y contraseña (mínimo 6).");
    return;
  }
  if (!isAdminEmail(email)) {
    showLoginHint("Ese correo no está en la allowlist de administradores.");
    return;
  }

  try {
    await createUserWithEmailAndPassword(auth, email, pass);
    toast("Usuario creado. Ya puedes ingresar.", "success");
  } catch (err) {
    console.error(err);
    showLoginHint("No se pudo crear el usuario. Quizás ya existe.");
  }
});


btnLogout?.addEventListener("click", async () => {
  await signOut(auth);
});

btnRefresh?.addEventListener("click", () => {
  if (!currentUser) return;
  loadAllInitial();
});

btnExportAll?.addEventListener("click", async () => {
  if (!currentUser) return;
  try {
    toast("Generando exportación rápida…", "info");
    const [contactsRows, subsRows] = await Promise.all([
      fetchContactsForExport("all", 1000),
      fetchSubsForExport("all", "all", 1000),
    ]);
    exportToXlsx(contactsRows, "fundvisa_mensajes.xlsx", "Mensajes");
    exportToXlsx(subsRows, "fundvisa_inscripciones.xlsx", "Inscripciones");
  } catch (e) {
    console.error(e);
    toast("No se pudo exportar.", "danger");
  }
});

function showLoginHint(msg) {
  if (!loginHint) return;
  loginHint.textContent = msg;
  loginHint.classList.remove("d-none");
}

function hideLoginHint() {
  loginHint?.classList.add("d-none");
}

onAuthStateChanged(auth, async (user) => {
  currentUser = user || null;

  if (!user) {
    loginView?.classList.remove("d-none");
    appView?.classList.add("d-none");
    btnLogout?.classList.add("d-none");
    userEmailEl.textContent = "-";
    return;
  }

  const email = user.email || "";
  if (!isAdminEmail(email)) {
    toast("Acceso denegado: este usuario no es admin.", "danger");
    await signOut(auth);
    return;
  }

  hideLoginHint();
  loginView?.classList.add("d-none");
  appView?.classList.remove("d-none");
  btnLogout?.classList.remove("d-none");
  userEmailEl.textContent = email || "(sin correo)";

  // Carga inicial
  await loadAllInitial();
});

/** ========================================================================
 *  Tabs Loaders
 *  ======================================================================== */
async function loadAllInitial() {
  // Resetea cursores
  galleryCursor = null; galleryLoaded = 0;
  contactsCursor = null; contactsLoaded = 0;
  subsCursor = null; subsLoaded = 0;
  projectsCursor = null; projectsLoaded = 0;

  await Promise.all([
    loadGalleryPage(true),
    loadContactsPage(true),
    loadForms(),
    loadSubsPage(true),
    loadProjectsPage(true),
  ]);

  // cargar filtros
  fillFormsFilterForSubs();
}

// =============================================================
// GALERÍA POR ÁLBUMES
// =============================================================
const ALBUMS_COL = "galleryAlbums";
const PHOTOS_SUB = "photos";

// Extrae URLs pegadas en cualquier formato (una por línea, separadas por espacios, tabs, comas, etc.)
function parseUrlList(raw) {
  const s = String(raw || "");
  // Preferimos regex para evitar errores tipo iterar caracteres y terminar guardando "h", "t", "t", "p"...
  const matches = s.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  const cleaned = matches
    .map(u => cleanUrl(u))
    .filter(Boolean);
  // Quitar duplicados preservando orden
  const unique = [];
  const seen = new Set();
  for (const u of cleaned) {
    if (seen.has(u)) continue;
    seen.add(u);
    unique.push(u);
  }
  return unique.slice(0, 200);
}

// Limpia fotos inválidas de un álbum (ej: las que quedaron como "h", "t", "p", etc.)
async function deleteInvalidAlbumPhotos(albumId) {
  if (!albumId) return;
  const snap = await getDocs(query(collection(db, ALBUMS_COL, albumId, PHOTOS_SUB)));
  const bad = [];
  snap.forEach((d) => {
    const u = String(d.data()?.imageUrl || "").trim();
    const ok = /^https?:\/\//i.test(u);
    if (!ok || u.length < 12) bad.push(d.id);
  });

  if (!bad.length) {
    toast("No se encontraron fotos inválidas en este álbum.", "success");
    return;
  }

  // Borrado secuencial para no saturar
  for (const id of bad) {
    await deleteDoc(doc(db, ALBUMS_COL, albumId, PHOTOS_SUB, id));
  }
  toast(`Eliminadas ${bad.length} fotos inválidas.`, "success");
  // refrescar lista (si el modal de fotos está abierto)
  if (typeof openAlbumId !== "undefined" && openAlbumId === albumId && typeof loadAlbumPhotosPage === "function") {
    await loadAlbumPhotosPage(true);
  }
}

// Exponer en window para usar desde consola si lo necesitas
window.FV_deleteInvalidAlbumPhotos = deleteInvalidAlbumPhotos;


let openAlbumId = null;
let albumPhotosCursor = null;
let albumPhotosLoaded = 0;

const galleryTbody = $("#galleryTbody");   // reutilizado para listar ÁLBUMES
const galleryCount = $("#galleryCount");

const apAlbumSelect = $("#apAlbumId");

// Modal (gestión de fotos por álbum)
const albumPhotosModal = $("#albumPhotosModal");
const albumPhotosModalObj = albumPhotosModal ? new window.bootstrap.Modal(albumPhotosModal) : null;
const albumPhotosTbody = $("#albumPhotosTbody");
const albumPhotosCount = $("#albumPhotosCount");

$("#btnMoreGallery")?.addEventListener("click", () => loadGalleryPage(false)); // "Ver más álbumes"
$("#btnExportGallery")?.addEventListener("click", async () => {
  const rows = await fetchAlbumsForExport(2000);
  exportToXlsx(rows, "fundvisa_albumes.xlsx", "Albumes");
});

$("#btnMoreAlbumPhotos")?.addEventListener("click", () => loadAlbumPhotosPage(false));
$("#btnExportAlbumPhotos")?.addEventListener("click", async () => {
  if (!openAlbumId) return;
  const rows = await fetchAlbumPhotosForExport(openAlbumId, 2000);
  exportToXlsx(rows, `fundvisa_album_${openAlbumId}.xlsx`, "Fotos");
});

// Limpieza formularios
$("#btnClearAlbumForm")?.addEventListener("click", () => {
  $("#aTitle").value = "";
  $("#aDesc").value = "";
  $("#aOrder").value = "1";
  $("#aActive").checked = true;
  $("#aCoverFile").value = "";
  $("#aCoverUrl").value = "";
});

$("#btnClearAlbumPhotosForm")?.addEventListener("click", () => {
  $("#apCaption").value = "";
  $("#apOrderStart").value = "1";
  $("#apActive").checked = true;
  $("#apFiles").value = "";
  $("#apUrls").value = "";
});

$("#btnCleanInvalidPhotos")?.addEventListener("click", async () => {
  const albumId = String(apAlbumSelect?.value || "").trim();
  if (!albumId) return toast("Selecciona un álbum primero.", "warning");
  await deleteInvalidAlbumPhotos(albumId);
});

// Crear Álbum
$("#albumForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const title = cleanText($("#aTitle")?.value, { max: 120, allowNewlines: false });
  const desc = cleanText($("#aDesc")?.value, { max: 500, allowNewlines: true });
  const order = clampInt($("#aOrder")?.value, { min: 1, max: 999, fallback: 1 });
  const active = !!$("#aActive")?.checked;

  const coverUrlInput = cleanUrl($("#aCoverUrl")?.value);
  const coverFile = $("#aCoverFile")?.files?.[0] || null;

  if (!title) {
    toast("El nombre del álbum es obligatorio.", "warning");
    return;
  }

  const progress = $("#aProgress");
  progress?.classList.add("d-none");
  setProgress(progress, 0);

  let coverUrl = coverUrlInput;
  let coverStoragePath = "";

  try {
    if (coverFile) {
      const chk = fileOk(coverFile);
      if (!chk.ok) {
        toast(chk.reason, "warning");
        return;
      }
      progress?.classList.remove("d-none");

      const ext = (coverFile.name.split(".").pop() || "jpg").toLowerCase().slice(0, 5);
      coverStoragePath = `galleryAlbums/${new Date().getFullYear()}/${uid("cover")}.${ext}`;
      const storageRef = ref(storage, coverStoragePath);
      const task = uploadBytesResumable(storageRef, coverFile, { contentType: coverFile.type });

      await new Promise((resolve, reject) => {
        task.on("state_changed", (snap) => {
          const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
          setProgress(progress, pct);
        }, reject, resolve);
      });

      coverUrl = await getDownloadURL(task.snapshot.ref);
    }

    await addDoc(collection(db, ALBUMS_COL), {
      title,
      desc,
      order,
      active,
      coverUrl,
      coverStoragePath,
      photosCount: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    toast("Álbum creado.", "success");
    $("#btnClearAlbumForm")?.click();
    await loadGalleryPage(true);
  } catch (err) {
    console.error(err);
    toast("No se pudo crear el álbum.", "danger");
  } finally {
    progress?.classList.add("d-none");
  }
});

// Subir múltiples fotos a un álbum (archivos + URLs)
$("#albumPhotosForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const albumId = String(apAlbumSelect?.value || "").trim();
  const caption = cleanText($("#apCaption")?.value, { max: 140, allowNewlines: false });
  const orderStart = clampInt($("#apOrderStart")?.value, { min: 1, max: 999, fallback: 1 });
  const active = !!$("#apActive")?.checked;

  const files = Array.from($("#apFiles")?.files || []);
  const urls = parseUrlList($("#apUrls")?.value);

  if (!albumId) {
    toast("Selecciona un álbum.", "warning");
    return;
  }
  if (!files.length && !urls.length) {
    toast("Sube imágenes o pega URLs (una por línea).", "warning");
    return;
  }

  // Validación de archivos
  for (const f of files) {
    const chk = fileOk(f);
    if (!chk.ok) {
      toast(chk.reason, "warning");
      return;
    }
  }

  const progress = $("#apProgress");
  progress?.classList.add("d-none");
  setProgress(progress, 0);

  const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
  let doneBytes = 0;

  let created = 0;
  let firstUrlForCover = "";

  try {
    progress?.classList.remove("d-none");

    // 1) Subir archivos a Storage
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase().slice(0, 5);
      const storagePath = `galleryAlbums/${albumId}/${uid("img")}.${ext}`;
      const storageRef = ref(storage, storagePath);
      const task = uploadBytesResumable(storageRef, file, { contentType: file.type });

      await new Promise((resolve, reject) => {
        task.on("state_changed", (snap) => {
          const part = doneBytes + snap.bytesTransferred;
          const pct = totalBytes ? Math.round((part / totalBytes) * 100) : 100;
          setProgress(progress, Math.min(100, Math.max(0, pct)));
        }, reject, resolve);
      });

      doneBytes += file.size || 0;
      const imageUrl = await getDownloadURL(task.snapshot.ref);
      if (!firstUrlForCover) firstUrlForCover = imageUrl;

      const ord = clampInt(orderStart + i, { min: 1, max: 999, fallback: orderStart + i });
      await addDoc(collection(db, ALBUMS_COL, albumId, PHOTOS_SUB), {
        caption,
        order: ord,
        active,
        imageUrl,
        storagePath,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      created++;
    }

    // 2) Guardar URLs externas como fotos
    for (let j = 0; j < urls.length; j++) {
      const imageUrl = urls[j];
      if (!firstUrlForCover) firstUrlForCover = imageUrl;

      const ord = clampInt(orderStart + files.length + j, { min: 1, max: 999, fallback: orderStart + files.length + j });
      await addDoc(collection(db, ALBUMS_COL, albumId, PHOTOS_SUB), {
        caption,
        order: ord,
        active,
        imageUrl,
        storagePath: "",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      created++;
    }

    // 3) Actualizar contador y portada (si no existe)
    const albumRef = doc(db, ALBUMS_COL, albumId);
    const aSnap = await getDoc(albumRef);
    const aData = aSnap.data() || {};
    const patch = {
      photosCount: increment(created),
      updatedAt: serverTimestamp(),
    };
    if (!aData.coverUrl && firstUrlForCover) patch.coverUrl = firstUrlForCover;

    await updateDoc(albumRef, patch);

    toast(`Listo: ${created} foto(s) cargadas al álbum.`, "success");
    $("#btnClearAlbumPhotosForm")?.click();
    await loadGalleryPage(true);
  } catch (err) {
    console.error(err);
    toast("No se pudieron subir las fotos.", "danger");
  } finally {
    progress?.classList.add("d-none");
  }
});

async function loadGalleryPage(reset) {
  if (!galleryTbody) return;

  if (reset) {
    galleryCursor = null;
    galleryLoaded = 0;
    galleryTbody.innerHTML = "";
  }

  // Listado de álbumes (admin)
  let q = query(collection(db, ALBUMS_COL), orderBy("createdAt", "desc"), limit(PAGE_SIZE));
  if (galleryCursor) q = query(collection(db, ALBUMS_COL), orderBy("createdAt", "desc"), startAfter(galleryCursor), limit(PAGE_SIZE));

  const snap = await getDocs(q);
  if (!snap.empty) galleryCursor = snap.docs[snap.docs.length - 1];

  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  galleryLoaded += rows.length;

  galleryTbody.insertAdjacentHTML("beforeend", rows.map(renderAlbumRow).join(""));
  galleryCount.textContent = `${galleryLoaded} álbum(es)`;

  rows.forEach(r => bindAlbumRow(r.id));
  // Actualiza select de álbumes para carga de fotos
  await refreshAlbumSelect();
}

function renderAlbumRow(it) {
  const id = it.id;
  const title = cleanText(it.title || "", { max: 120, allowNewlines: false });
  const cover = cleanUrl(it.coverUrl || "") || "";
  const order = clampInt(it.order, { min: 1, max: 999, fallback: 1 });
  const active = !!it.active;
  const count = clampInt(it.photosCount, { min: 0, max: 999999, fallback: 0 });

  const preview = cover ? `<img src="${cover}" class="fv-mini-img" alt="cover">` : "—";

  return `
    <tr id="a_${id}">
      <td class="ps-4">${preview}</td>
      <td style="min-width:240px;">
        <input class="form-control form-control-sm" value="${title}" data-atitle="${id}" maxlength="120">
      </td>
      <td style="max-width:110px;">
        <input class="form-control form-control-sm" type="number" min="1" max="999" value="${order}" data-aord="${id}">
      </td>
      <td>
        <div class="form-check form-switch">
          <input class="form-check-input" type="checkbox" data-aact="${id}" ${active ? "checked" : ""}>
          <label class="form-check-label small">${active ? "Visible" : "Oculto"}</label>
        </div>
      </td>
      <td><span class="badge text-bg-light">${count}</span></td>
      <td class="text-end pe-4">
        <button class="btn btn-outline-primary btn-sm" data-asave="${id}" title="Guardar"><i class="fas fa-floppy-disk"></i></button>
        <button class="btn btn-outline-success btn-sm" data-aphotos="${id}" title="Ver fotos"><i class="fas fa-images"></i></button>
        <button class="btn btn-outline-danger btn-sm" data-adel="${id}" title="Eliminar"><i class="fas fa-trash"></i></button>
      </td>
    </tr>
  `;
}

function bindAlbumRow(id) {
  const row = document.getElementById(`a_${id}`);
  if (!row) return;

  row.querySelector(`[data-asave="${id}"]`)?.addEventListener("click", async () => {
    const title = cleanText(row.querySelector(`[data-atitle="${id}"]`)?.value, { max: 120, allowNewlines: false });
    const ord = clampInt(row.querySelector(`[data-aord="${id}"]`)?.value, { min: 1, max: 999, fallback: 1 });
    const act = !!row.querySelector(`[data-aact="${id}"]`)?.checked;

    if (!title) {
      toast("El nombre del álbum es obligatorio.", "warning");
      return;
    }

    try {
      await updateDoc(doc(db, ALBUMS_COL, id), {
        title,
        order: ord,
        active: act,
        updatedAt: serverTimestamp(),
      });
      toast("Álbum actualizado.", "success");
      await refreshAlbumSelect();
    } catch (e) {
      console.error(e);
      toast("No se pudo actualizar el álbum.", "danger");
    }
  });

  row.querySelector(`[data-aphotos="${id}"]`)?.addEventListener("click", async () => {
    await openAlbumPhotos(id);
  });

  row.querySelector(`[data-adel="${id}"]`)?.addEventListener("click", async () => {
    if (!confirm("¿Eliminar este álbum? (Se eliminarán también sus fotos)")) return;
    try {
      await deleteAlbumCascade(id);
      toast("Álbum eliminado.", "success");
      await loadGalleryPage(true);
    } catch (e) {
      console.error(e);
      toast("No se pudo eliminar el álbum.", "danger");
    }
  });
}

async function refreshAlbumSelect() {
  if (!apAlbumSelect) return;

  // Trae hasta 60 álbumes recientes para el selector
  const snap = await getDocs(query(collection(db, ALBUMS_COL), orderBy("updatedAt", "desc"), limit(60)));
  const albums = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  apAlbumSelect.innerHTML = "";
  if (!albums.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(Crea un álbum primero)";
    apAlbumSelect.appendChild(opt);
    return;
  }

  albums.forEach(a => {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = cleanText(a.title || a.id, { max: 120, allowNewlines: false }) || a.id;
    apAlbumSelect.appendChild(opt);
  });
}

async function openAlbumPhotos(albumId) {
  openAlbumId = albumId;
  albumPhotosCursor = null;
  albumPhotosLoaded = 0;
  if (albumPhotosTbody) albumPhotosTbody.innerHTML = "";

  // Título + meta
  try {
    const aSnap = await getDoc(doc(db, ALBUMS_COL, albumId));
    const a = aSnap.data() || {};
    $("#apmTitle").textContent = a.title || "Álbum";
    $("#apmMeta").textContent = a.desc ? cleanText(a.desc, { max: 200, allowNewlines: false }) : `ID: ${albumId}`;
  } catch {
    $("#apmTitle").textContent = "Álbum";
    $("#apmMeta").textContent = `ID: ${albumId}`;
  }

  await loadAlbumPhotosPage(true);
  albumPhotosModalObj?.show();
}

async function loadAlbumPhotosPage(reset) {
  if (!openAlbumId || !albumPhotosTbody) return;

  if (reset) {
    albumPhotosCursor = null;
    albumPhotosLoaded = 0;
    albumPhotosTbody.innerHTML = "";
  }

  let q = query(collection(db, ALBUMS_COL, openAlbumId, PHOTOS_SUB), orderBy("createdAt", "desc"), limit(PAGE_SIZE));
  if (albumPhotosCursor) {
    q = query(collection(db, ALBUMS_COL, openAlbumId, PHOTOS_SUB), orderBy("createdAt", "desc"), startAfter(albumPhotosCursor), limit(PAGE_SIZE));
  }

  const snap = await getDocs(q);
  if (!snap.empty) albumPhotosCursor = snap.docs[snap.docs.length - 1];

  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  albumPhotosLoaded += rows.length;

  albumPhotosTbody.insertAdjacentHTML("beforeend", rows.map(renderAlbumPhotoRow).join(""));
  if (albumPhotosCount) albumPhotosCount.textContent = `${albumPhotosLoaded} cargadas`;

  rows.forEach(r => bindAlbumPhotoRow(r.id));
}

function renderAlbumPhotoRow(it) {
  const id = it.id;
  const preview = it.imageUrl ? `<img src="${cleanUrl(it.imageUrl) || ""}" class="fv-mini-img" alt="preview">` : "—";
  const cap = cleanText(it.caption || "", { max: 140, allowNewlines: false });
  const active = !!it.active;
  const order = clampInt(it.order, { min: 1, max: 999, fallback: 1 });

  return `
    <tr id="p_${id}">
      <td class="ps-4">${preview}</td>
      <td>
        <input class="form-control form-control-sm" value="${cap}" data-pcap="${id}" maxlength="140">
      </td>
      <td style="max-width:110px;">
        <input class="form-control form-control-sm" type="number" min="1" max="999" value="${order}" data-pord="${id}">
      </td>
      <td>
        <div class="form-check form-switch">
          <input class="form-check-input" type="checkbox" data-pact="${id}" ${active ? "checked" : ""}>
          <label class="form-check-label small">${active ? "Visible" : "Oculta"}</label>
        </div>
      </td>
      <td class="text-end pe-4">
        <button class="btn btn-outline-primary btn-sm" data-psave="${id}"><i class="fas fa-floppy-disk"></i></button>
        <button class="btn btn-outline-danger btn-sm" data-pdel="${id}"><i class="fas fa-trash"></i></button>
      </td>
    </tr>
  `;
}

function bindAlbumPhotoRow(photoId) {
  const row = document.getElementById(`p_${photoId}`);
  if (!row) return;

  row.querySelector(`[data-psave="${photoId}"]`)?.addEventListener("click", async () => {
    if (!openAlbumId) return;

    const cap = cleanText(row.querySelector(`[data-pcap="${photoId}"]`)?.value, { max: 140, allowNewlines: false });
    const ord = clampInt(row.querySelector(`[data-pord="${photoId}"]`)?.value, { min: 1, max: 999, fallback: 1 });
    const act = !!row.querySelector(`[data-pact="${photoId}"]`)?.checked;

    try {
      await updateDoc(doc(db, ALBUMS_COL, openAlbumId, PHOTOS_SUB, photoId), {
        caption: cap,
        order: ord,
        active: act,
        updatedAt: serverTimestamp(),
      });
      toast("Foto actualizada.", "success");
    } catch (e) {
      console.error(e);
      toast("No se pudo actualizar la foto.", "danger");
    }
  });

  row.querySelector(`[data-pdel="${photoId}"]`)?.addEventListener("click", async () => {
    if (!openAlbumId) return;
    if (!confirm("¿Eliminar esta foto?")) return;

    try {
      const refDoc = doc(db, ALBUMS_COL, openAlbumId, PHOTOS_SUB, photoId);
      const snap = await getDoc(refDoc);
      const data = snap.data() || {};
      const storagePath = data.storagePath || "";

      await deleteDoc(refDoc);
      if (storagePath) {
        try { await deleteObject(ref(storage, storagePath)); } catch { /* ignore */ }
      }

      await updateDoc(doc(db, ALBUMS_COL, openAlbumId), {
        photosCount: increment(-1),
        updatedAt: serverTimestamp(),
      });

      toast("Eliminada.", "success");
      await loadAlbumPhotosPage(true);
      await loadGalleryPage(true);
    } catch (e) {
      console.error(e);
      toast("No se pudo eliminar la foto.", "danger");
    }
  });
}

async function deleteAlbumCascade(albumId) {
  // Borra fotos (subcolección) y luego el álbum
  const photosSnap = await getDocs(query(collection(db, ALBUMS_COL, albumId, PHOTOS_SUB), limit(500)));
  for (const d of photosSnap.docs) {
    const p = d.data() || {};
    const storagePath = p.storagePath || "";
    await deleteDoc(d.ref);
    if (storagePath) {
      try { await deleteObject(ref(storage, storagePath)); } catch { /* ignore */ }
    }
  }

  // Borra portada en storage si aplica
  const aRef = doc(db, ALBUMS_COL, albumId);
  const aSnap = await getDoc(aRef);
  const a = aSnap.data() || {};
  const coverStoragePath = a.coverStoragePath || "";
  await deleteDoc(aRef);
  if (coverStoragePath) {
    try { await deleteObject(ref(storage, coverStoragePath)); } catch { /* ignore */ }
  }
}

async function fetchAlbumsForExport(maxRows = 2000) {
  const q = query(collection(db, ALBUMS_COL), orderBy("createdAt", "desc"), limit(maxRows));
  const snap = await getDocs(q);
  const out = [];
  snap.forEach(d => {
    const x = d.data() || {};
    out.push({
      id: d.id,
      title: x.title || "",
      desc: x.desc || "",
      order: x.order ?? "",
      active: !!x.active,
      photosCount: x.photosCount ?? 0,
      coverUrl: x.coverUrl || "",
      createdAt: fmtDate(x.createdAt),
      updatedAt: fmtDate(x.updatedAt),
    });
  });
  return out;
}

async function fetchAlbumPhotosForExport(albumId, maxRows = 2000) {
  const q = query(collection(db, ALBUMS_COL, albumId, PHOTOS_SUB), orderBy("createdAt", "desc"), limit(maxRows));
  const snap = await getDocs(q);
  const out = [];
  snap.forEach(d => {
    const x = d.data() || {};
    out.push({
      id: d.id,
      albumId,
      caption: x.caption || "",
      order: x.order ?? "",
      active: !!x.active,
      imageUrl: x.imageUrl || "",
      storagePath: x.storagePath || "",
      createdAt: fmtDate(x.createdAt),
    });
  });
  return out;
}

// =============================================================
// CONTACTOS
// =============================================================
const contactsTbody = $("#contactsTbody");
const contactsCount = $("#contactsCount");
const cStatus = $("#cStatus");

cStatus?.addEventListener("change", () => {
  contactsFilter = cStatus.value || "new";
  loadContactsPage(true);
});
$("#btnMoreContacts")?.addEventListener("click", () => loadContactsPage(false));
$("#btnExportContacts")?.addEventListener("click", async () => {
  const rows = await fetchContactsForExport(contactsFilter, 2000);
  exportToXlsx(rows, "fundvisa_mensajes.xlsx", "Mensajes");
});

const contactModal = $("#contactModal");
const contactModalObj = contactModal ? new window.bootstrap.Modal(contactModal) : null;

async function loadContactsPage(reset) {
  if (!contactsTbody) return;

  if (reset) {
    contactsCursor = null;
    contactsLoaded = 0;
    contactsTbody.innerHTML = "";
  }

  let base = collection(db, "contactMessages");
  let q;

  if (contactsFilter === "all") {
    q = query(base, orderBy("createdAt", "desc"), limit(PAGE_SIZE));
  } else {
    q = query(base, where("status", "==", contactsFilter), orderBy("createdAt", "desc"), limit(PAGE_SIZE));
  }

  if (contactsCursor) {
    if (contactsFilter === "all") {
      q = query(base, orderBy("createdAt", "desc"), startAfter(contactsCursor), limit(PAGE_SIZE));
    } else {
      q = query(base, where("status", "==", contactsFilter), orderBy("createdAt", "desc"), startAfter(contactsCursor), limit(PAGE_SIZE));
    }
  }

  const snap = await getDocs(q);
  if (!snap.empty) contactsCursor = snap.docs[snap.docs.length - 1];

  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  contactsLoaded += rows.length;

  contactsTbody.insertAdjacentHTML("beforeend", rows.map(renderContactRow).join(""));
  contactsCount.textContent = `${contactsLoaded} cargados`;

  rows.forEach(r => bindContactRow(r.id));
}

function renderContactRow(it) {
  const id = it.id;
  return `
    <tr id="c_${id}">
      <td>${fmtDate(it.createdAt) || "—"}</td>
      <td>${cleanText(it.name || "", { max: 80, allowNewlines: false })}</td>
      <td>${cleanText(it.email || "", { max: 120, allowNewlines: false })}</td>
      <td>${statusBadge(it.status, {
        new: ["Nuevo", "text-bg-warning"],
        read: ["Leído", "text-bg-primary"],
        archived: ["Archivado", "text-bg-secondary"],
      })}</td>
      <td class="text-end">
        <button class="btn btn-outline-primary btn-sm" data-cview="${id}" title="Ver"><i class="fas fa-eye"></i></button>
        <button class="btn btn-outline-secondary btn-sm" data-carchive="${id}" title="Archivar"><i class="fas fa-box-archive"></i></button>
        <button class="btn btn-outline-danger btn-sm" data-cdel="${id}" title="Eliminar"><i class="fas fa-trash"></i></button>
      </td>
    </tr>
  `;
}

function bindContactRow(id) {
  const row = document.getElementById(`c_${id}`);
  if (!row) return;

  row.querySelector(`[data-cview="${id}"]`)?.addEventListener("click", async () => {
    openContactId = id;
    const snap = await getDoc(doc(db, "contactMessages", id));
    const it = snap.data() || {};
    $("#cmName").textContent = it.name || "—";
    $("#cmEmail").textContent = it.email || "—";
    $("#cmPhone").textContent = it.phone || "—";
    $("#cmDate").textContent = fmtDate(it.createdAt) || "—";
    $("#cmSubject").textContent = it.subject || "—";
    $("#cmMessage").textContent = it.message || "—";

    contactModalObj?.show();
  });

  row.querySelector(`[data-carchive="${id}"]`)?.addEventListener("click", async () => {
    await updateDoc(doc(db, "contactMessages", id), { status: "archived", updatedAt: serverTimestamp() });
    toast("Archivado.", "success");
    await loadContactsPage(true);
  });

  row.querySelector(`[data-cdel="${id}"]`)?.addEventListener("click", async () => {
    if (!confirm("¿Eliminar este mensaje?")) return;
    await deleteDoc(doc(db, "contactMessages", id));
    toast("Eliminado.", "success");
    await loadContactsPage(true);
  });
}

$("#cmMarkRead")?.addEventListener("click", async () => {
  if (!openContactId) return;
  await updateDoc(doc(db, "contactMessages", openContactId), { status: "read", updatedAt: serverTimestamp() });
  toast("Marcado como leído.", "success");
  contactModalObj?.hide();
  await loadContactsPage(true);
});
$("#cmArchive")?.addEventListener("click", async () => {
  if (!openContactId) return;
  await updateDoc(doc(db, "contactMessages", openContactId), { status: "archived", updatedAt: serverTimestamp() });
  toast("Archivado.", "success");
  contactModalObj?.hide();
  await loadContactsPage(true);
});
$("#cmDelete")?.addEventListener("click", async () => {
  if (!openContactId) return;
  if (!confirm("¿Eliminar este mensaje?")) return;
  await deleteDoc(doc(db, "contactMessages", openContactId));
  toast("Eliminado.", "success");
  contactModalObj?.hide();
  await loadContactsPage(true);
});

async function fetchContactsForExport(filter = "all", maxRows = 2000) {
  const base = collection(db, "contactMessages");
  let q;
  if (filter === "all") q = query(base, orderBy("createdAt", "desc"), limit(maxRows));
  else q = query(base, where("status", "==", filter), orderBy("createdAt", "desc"), limit(maxRows));

  const snap = await getDocs(q);
  const out = [];
  snap.forEach(d => {
    const x = d.data() || {};
    out.push({
      id: d.id,
      createdAt: fmtDate(x.createdAt),
      status: x.status || "",
      name: x.name || "",
      email: x.email || "",
      phone: x.phone || "",
      subject: x.subject || "",
      message: x.message || "",
    });
  });
  return out;
}

// =============================================================
// FORMULARIOS
// =============================================================
const formsTbody = $("#formsTbody");
const btnReloadForms = $("#btnReloadForms");
const formCreate = $("#formCreate");
const formSelectedEmpty = $("#formSelectedEmpty");
const formEditor = $("#formEditor");
const selFormTitle = $("#selFormTitle");
const selFormMeta = $("#selFormMeta");
const fieldsTbody = $("#fieldsTbody");

// -------------------------------------------------------------
// Vista de Formularios: "Crear Evento" vs "Formularios Existentes"
// - En modo "Existentes", el Editor de Preguntas ocupa más espacio.
// -------------------------------------------------------------
const formsViewCreateBtn = $("#formsViewCreate");
const formsViewManageBtn = $("#formsViewManage");
const formsLeftCol = $("#formsLeftCol");
const formsRightCol = $("#formsRightCol");
const formsCreateCard = $("#formsCreateCard");
const formsEditorCard = $("#formsEditorCard");
const formsListCard = $("#formsListCard");

const LS_FORMS_VIEW = "fv_forms_view_v1";
let _formsLayoutCached = false;

function setLgCol(el, size) {
  if (!el) return;
  el.classList.remove("col-lg-4", "col-lg-6", "col-lg-8", "col-lg-12");
  el.classList.add(`col-lg-${size}`);
}

function setFormsView(mode) {
  const m = (mode === "create") ? "create" : "manage";
  try { localStorage.setItem(LS_FORMS_VIEW, m); } catch { /* ignore */ }

  // Botones
  formsViewCreateBtn?.classList.toggle("active", m === "create");
  formsViewManageBtn?.classList.toggle("active", m === "manage");

  // Create view: solo crear (más limpio y amplio)
  if (m === "create") {
    formsCreateCard?.classList.remove("d-none");
    formsEditorCard?.classList.add("d-none");
    formsRightCol?.classList.add("d-none");

    // Columna centrada y más amplia
    if (formsLeftCol) {
      formsLeftCol.classList.remove("order-lg-1", "order-lg-2");
      setLgCol(formsLeftCol, 6);
      formsLeftCol.classList.add("mx-auto");
    }
    return;
  }

  // Manage view: lista + editor (editor grande)
  formsCreateCard?.classList.add("d-none");
  formsEditorCard?.classList.remove("d-none");
  formsRightCol?.classList.remove("d-none");

  if (formsLeftCol && formsRightCol) {
    formsLeftCol.classList.remove("mx-auto");
    setLgCol(formsLeftCol, 8);
    setLgCol(formsRightCol, 4);

    // En escritorio: lista a la izquierda, editor a la derecha
    formsRightCol.classList.add("order-lg-1");
    formsLeftCol.classList.add("order-lg-2");
  }
}

function initFormsViewToggle() {
  if (_formsLayoutCached) return;
  _formsLayoutCached = true;

  formsViewCreateBtn?.addEventListener("click", () => setFormsView("create"));
  formsViewManageBtn?.addEventListener("click", () => setFormsView("manage"));

  let saved = "manage";
  try { saved = localStorage.getItem(LS_FORMS_VIEW) || "manage"; } catch { /* ignore */ }
  setFormsView(saved);
}

initFormsViewToggle();


btnReloadForms?.addEventListener("click", () => loadForms());
formCreate?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = cleanText($("#fTitle")?.value, { max: 120, allowNewlines: false });
  const desc = cleanText($("#fDesc")?.value, { max: 500, allowNewlines: true });
  const active = !!$("#fActive")?.checked;

  if (!title) {
    toast("El título es obligatorio.", "warning");
    return;
  }

  const payload = {
    title,
    desc,
    active: false, // se activa con botón para asegurar única activa
    fields: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    const refDoc = await addDoc(collection(db, "forms"), payload);
    toast("Formulario creado.", "success");
    $("#fTitle").value = "";
    $("#fDesc").value = "";
    $("#fActive").checked = false;

    await loadForms();
    if (active) await setActiveForm(refDoc.id);
  } catch (err) {
    console.error(err);
    toast("No se pudo crear el formulario.", "danger");
  }
});

$("#btnAddField")?.addEventListener("click", () => openFieldModal(-1));
$("#ffSave")?.addEventListener("click", () => saveFieldFromModal());
$("#btnSaveFields")?.addEventListener("click", () => persistFields());
$("#btnSetActiveForm")?.addEventListener("click", () => selectedFormId && setActiveForm(selectedFormId));
$("#btnDeleteForm")?.addEventListener("click", async () => {
  if (!selectedFormId) return;
  if (!confirm("¿Eliminar este formulario? (No borra inscripciones ya enviadas)")) return;
  await deleteDoc(doc(db, "forms", selectedFormId));
  selectedFormId = null;
  selectedFieldsDraft = [];
  toast("Formulario eliminado.", "success");
  await loadForms();
});

function ensureFieldModal() {
  if (!fieldModal) {
    const el = $("#fieldModal");
    if (el) fieldModal = new window.bootstrap.Modal(el);
  }
}

function openFieldModal(index) {
  ensureFieldModal();
  if (!fieldModal) return;

  $("#ffIndex").value = String(index);

  const f = index >= 0 ? selectedFieldsDraft[index] : null;
  $("#ffLabel").value = f?.label || "";
  $("#ffType").value = f?.type || "text";
  $("#ffRequired").checked = !!f?.required;
  $("#ffHelp").value = f?.help || "";
  $("#ffOptions").value = (Array.isArray(f?.options) ? f.options.join("\n") : "");

  toggleOptionsWrap();
  fieldModal.show();
}

$("#ffType")?.addEventListener("change", toggleOptionsWrap);
function toggleOptionsWrap() {
  const type = $("#ffType")?.value || "text";
  const wrap = $("#ffOptionsWrap");
  const needs = ["select", "radio", "multiselect"].includes(type);
  wrap?.classList.toggle("d-none", !needs);
}

function saveFieldFromModal() {
  const idx = clampInt($("#ffIndex").value, { min: -1, max: 9999, fallback: -1 });

  const label = cleanText($("#ffLabel")?.value, { max: 120, allowNewlines: false });
  const type = String($("#ffType")?.value || "text");
  const required = !!$("#ffRequired")?.checked;
  const help = cleanText($("#ffHelp")?.value, { max: 200, allowNewlines: false });

  if (!label) {
    toast("La etiqueta es obligatoria.", "warning");
    return;
  }

  let options = [];
  if (["select", "radio", "multiselect"].includes(type)) {
    options = String($("#ffOptions")?.value || "")
      .split("\n")
      .map(x => cleanText(x, { max: 80, allowNewlines: false }))
      .filter(Boolean)
      .slice(0, 80);

    if (options.length < 2) {
      toast("Agrega al menos 2 opciones.", "warning");
      return;
    }
  }

  const field = {
    id: uid("q").slice(0, 30),
    label,
    type,
    required,
    help,
    options,
  };

  if (idx >= 0 && selectedFieldsDraft[idx]) {
    // preserva id al editar
    field.id = selectedFieldsDraft[idx].id || field.id;
    selectedFieldsDraft[idx] = field;
  } else {
    selectedFieldsDraft.push(field);
  }

  renderFieldsTable();
  fieldModal?.hide();
}

function renderFieldsTable() {
  if (!fieldsTbody) return;
  fieldsTbody.innerHTML = selectedFieldsDraft.map((f, idx) => `
    <tr>
      <td>${cleanText(f.label || "", { max: 120, allowNewlines: false })}</td>
      <td>${cleanText(f.type || "", { max: 40, allowNewlines: false })}</td>
      <td>${f.required ? "Sí" : "No"}</td>
      <td class="text-end">
        <button class="btn btn-outline-primary btn-sm" data-fedit="${idx}" title="Editar"><i class="fas fa-pen"></i></button>
        <button class="btn btn-outline-secondary btn-sm" data-fup="${idx}" title="Subir"><i class="fas fa-arrow-up"></i></button>
        <button class="btn btn-outline-secondary btn-sm" data-fdown="${idx}" title="Bajar"><i class="fas fa-arrow-down"></i></button>
        <button class="btn btn-outline-danger btn-sm" data-fdel="${idx}" title="Eliminar"><i class="fas fa-trash"></i></button>
      </td>
    </tr>
  `).join("");

  // bind
  $$("[data-fedit]").forEach(b => b.addEventListener("click", () => openFieldModal(clampInt(b.dataset.fedit, { min: 0, max: 9999, fallback: 0 }))));
  $$("[data-fdel]").forEach(b => b.addEventListener("click", () => {
    const idx = clampInt(b.dataset.fdel, { min: 0, max: 9999, fallback: 0 });
    selectedFieldsDraft.splice(idx, 1);
    renderFieldsTable();
  }));
  $$("[data-fup]").forEach(b => b.addEventListener("click", () => {
    const idx = clampInt(b.dataset.fup, { min: 0, max: 9999, fallback: 0 });
    if (idx <= 0) return;
    const tmp = selectedFieldsDraft[idx - 1];
    selectedFieldsDraft[idx - 1] = selectedFieldsDraft[idx];
    selectedFieldsDraft[idx] = tmp;
    renderFieldsTable();
  }));
  $$("[data-fdown]").forEach(b => b.addEventListener("click", () => {
    const idx = clampInt(b.dataset.fdown, { min: 0, max: 9999, fallback: 0 });
    if (idx >= selectedFieldsDraft.length - 1) return;
    const tmp = selectedFieldsDraft[idx + 1];
    selectedFieldsDraft[idx + 1] = selectedFieldsDraft[idx];
    selectedFieldsDraft[idx] = tmp;
    renderFieldsTable();
  }));
}

async function persistFields() {
  if (!selectedFormId) return;
  if (!selectedFieldsDraft.length) {
    toast("Agrega al menos una pregunta.", "warning");
    return;
  }

  try {
    await updateDoc(doc(db, "forms", selectedFormId), {
      fields: selectedFieldsDraft,
      updatedAt: serverTimestamp(),
    });
    toast("Preguntas guardadas.", "success");
    await loadForms();
  } catch (err) {
    console.error(err);
    toast("No se pudieron guardar las preguntas.", "danger");
  }
}

async function setActiveForm(formId) {
  // asegura única activa: set false a todas, true a la elegida
  try {
    const snap = await getDocs(query(collection(db, "forms"), limit(50)));
    const batch = writeBatch(db);

    snap.forEach(d => {
      batch.update(d.ref, {
        active: d.id === formId,
        updatedAt: serverTimestamp(),
      });
    });

    await batch.commit();
    toast("Formulario activado.", "success");
    await loadForms();
    await loadSubsPage(true); // refresca inscripciones
  } catch (err) {
    console.error(err);
    toast("No se pudo activar el formulario.", "danger");
  }
}

async function loadForms() {
  if (!formsTbody) return;

  const q = query(collection(db, "forms"), orderBy("updatedAt", "desc"), limit(50));
  const snap = await getDocs(q);
  formsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  formsTbody.innerHTML = formsCache.map(renderFormRow).join("");

  // bind
  formsCache.forEach(f => {
    document.querySelector(`[data-fsel="${f.id}"]`)?.addEventListener("click", () => selectForm(f.id));
  });

  fillFormsFilterForSubs();
}

function renderFormRow(f) {
  const active = !!f.active;
  return `
    <tr>
      <td>${cleanText(f.title || "", { max: 120, allowNewlines: false })}</td>
      <td>${active ? `<span class="badge text-bg-success">Activo</span>` : `<span class="badge text-bg-secondary">Inactivo</span>`}</td>
      <td>${fmtDate(f.updatedAt) || "—"}</td>
      <td class="text-end">
        <button class="btn btn-outline-primary btn-sm" data-fsel="${f.id}">
          <i class="fas fa-pen me-2"></i>Editar
        </button>
      </td>
    </tr>
  `;
}

function selectForm(id) {
  selectedFormId = id;
  const f = formsCache.find(x => x.id === id);
  if (!f) return;

  formSelectedEmpty?.classList.add("d-none");
  formEditor?.classList.remove("d-none");

  selFormTitle.textContent = f.title || "—";
  selFormMeta.textContent = `${f.active ? "Activo" : "Inactivo"} • Preguntas: ${(Array.isArray(f.fields) ? f.fields.length : 0)}`;

  selectedFieldsDraft = Array.isArray(f.fields) ? JSON.parse(JSON.stringify(f.fields)) : [];
  renderFieldsTable();
}

// =============================================================
// INSCRIPCIONES (SUBMISSIONS)
// =============================================================
const subsTbody = $("#subsTbody");
const subsCount = $("#subsCount");
const sStatus = $("#sStatus");
const sFormFilter = $("#sFormFilter");

sStatus?.addEventListener("change", () => {
  subsFilter = sStatus.value || "new";
  loadSubsPage(true);
});
sFormFilter?.addEventListener("change", () => {
  subsFormFilter = sFormFilter.value || "all";
  loadSubsPage(true);
});

$("#btnMoreSubs")?.addEventListener("click", () => loadSubsPage(false));
$("#btnExportSubs")?.addEventListener("click", async () => {
  const rows = await fetchSubsForExport(subsFilter, subsFormFilter, 2000);
  exportToXlsx(rows, "fundvisa_inscripciones.xlsx", "Inscripciones");
});

const subModal = $("#subModal");
const subModalObj = subModal ? new window.bootstrap.Modal(subModal) : null;

async function loadSubsPage(reset) {
  if (!subsTbody) return;

  if (reset) {
    subsCursor = null;
    subsLoaded = 0;
    subsTbody.innerHTML = "";
  }

  const base = collection(db, "formSubmissions");
  const clauses = [];

  if (subsFilter !== "all") clauses.push(where("status", "==", subsFilter));
  if (subsFormFilter !== "all") clauses.push(where("formId", "==", subsFormFilter));

  let q = query(base, ...clauses, orderBy("createdAt", "desc"), limit(PAGE_SIZE));
  if (subsCursor) q = query(base, ...clauses, orderBy("createdAt", "desc"), startAfter(subsCursor), limit(PAGE_SIZE));

  const snap = await getDocs(q);
  if (!snap.empty) subsCursor = snap.docs[snap.docs.length - 1];

  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  subsLoaded += rows.length;

  subsTbody.insertAdjacentHTML("beforeend", rows.map(renderSubRow).join(""));
  subsCount.textContent = `${subsLoaded} cargadas`;

  rows.forEach(r => bindSubRow(r.id));
}

function renderSubRow(it) {
  return `
    <tr id="s_${it.id}">
      <td>${fmtDate(it.createdAt) || "—"}</td>
      <td>${cleanText(it.formTitle || it.formId || "", { max: 120, allowNewlines: false })}</td>
      <td>${statusBadge(it.status, {
        new: ["Nueva", "text-bg-warning"],
        reviewed: ["Revisada", "text-bg-primary"],
        archived: ["Archivada", "text-bg-secondary"],
      })}</td>
      <td class="text-end">
        <button class="btn btn-outline-primary btn-sm" data-sview="${it.id}" title="Ver"><i class="fas fa-eye"></i></button>
        <button class="btn btn-outline-secondary btn-sm" data-sarch="${it.id}" title="Archivar"><i class="fas fa-box-archive"></i></button>
        <button class="btn btn-outline-danger btn-sm" data-sdel="${it.id}" title="Eliminar"><i class="fas fa-trash"></i></button>
      </td>
    </tr>
  `;
}

function bindSubRow(id) {
  const row = document.getElementById(`s_${id}`);
  if (!row) return;

  row.querySelector(`[data-sview="${id}"]`)?.addEventListener("click", async () => {
    openSubId = id;
    const snap = await getDoc(doc(db, "formSubmissions", id));
    const it = snap.data() || {};
    $("#smForm").textContent = it.formTitle || it.formId || "—";
    $("#smDate").textContent = fmtDate(it.createdAt) || "—";
    $("#smStatus").textContent = it.status || "—";

    
const answers = it.answers || {};

// Mapea q_xxx -> etiqueta humana usando el formulario asociado
const meta = await getFormMeta(it.formId);
const labelById = meta?.labelById || {};

// Mejor título del formulario en el modal
$("#smForm").textContent = (meta?.title || it.formTitle || it.formId || "—");

const keys = orderedAnswerKeys(answers, meta);

const html = keys.map((k) => {
  const raw = answers[k];
  const label = cleanText(labelById[k] || k, { max: 90, allowNewlines: false });
  const val = cleanText(answerToText(raw), { max: 2500, allowNewlines: true });

  // Si viene por ID, mostramos el ID pequeño para auditoría, pero no como título
  const metaLine = labelById[k]
    ? `<div class="small text-muted">ID: <code>${cleanText(k, { max: 40, allowNewlines: false })}</code></div>`
    : "";

  return `
    <div class="p-3 border rounded-3 bg-white mb-2">
      <div class="fw-semibold text-primary">${label}</div>
      ${metaLine}
      <div class="mt-2">${val || "<span class=\"text-muted\">—</span>"}</div>
    </div>
  `;
}).join("");

$("#smAnswers").innerHTML = html || `<div class="text-muted">Sin respuestas</div>`;
    subModalObj?.show();
  });

  row.querySelector(`[data-sarch="${id}"]`)?.addEventListener("click", async () => {
    await updateDoc(doc(db, "formSubmissions", id), { status: "archived", updatedAt: serverTimestamp() });
    toast("Archivada.", "success");
    await loadSubsPage(true);
  });

  row.querySelector(`[data-sdel="${id}"]`)?.addEventListener("click", async () => {
    if (!confirm("¿Eliminar esta inscripción?")) return;
    await deleteDoc(doc(db, "formSubmissions", id));
    toast("Eliminada.", "success");
    await loadSubsPage(true);
  });
}

$("#smReviewed")?.addEventListener("click", async () => {
  if (!openSubId) return;
  await updateDoc(doc(db, "formSubmissions", openSubId), { status: "reviewed", updatedAt: serverTimestamp() });
  toast("Marcada como revisada.", "success");
  subModalObj?.hide();
  await loadSubsPage(true);
});
$("#smArchive")?.addEventListener("click", async () => {
  if (!openSubId) return;
  await updateDoc(doc(db, "formSubmissions", openSubId), { status: "archived", updatedAt: serverTimestamp() });
  toast("Archivada.", "success");
  subModalObj?.hide();
  await loadSubsPage(true);
});
$("#smDelete")?.addEventListener("click", async () => {
  if (!openSubId) return;
  if (!confirm("¿Eliminar esta inscripción?")) return;
  await deleteDoc(doc(db, "formSubmissions", openSubId));
  toast("Eliminada.", "success");
  subModalObj?.hide();
  await loadSubsPage(true);
});

function fillFormsFilterForSubs() {
  if (!sFormFilter) return;
  const opts = [
    `<option value="all">Todos los formularios</option>`,
    ...formsCache.map(f => `<option value="${f.id}">${cleanText(f.title || f.id, { max: 80, allowNewlines: false })}</option>`),
  ];
  sFormFilter.innerHTML = opts.join("");
  sFormFilter.value = subsFormFilter;
}

async function fetchSubsForExport(status = "all", formId = "all", maxRows = 2000) {
  const base = collection(db, "formSubmissions");
  const clauses = [];
  if (status !== "all") clauses.push(where("status", "==", status));
  if (formId !== "all") clauses.push(where("formId", "==", formId));

  const q = query(base, ...clauses, orderBy("createdAt", "desc"), limit(maxRows));
  const snap = await getDocs(q);

  // Prefetch metas (evita N lecturas por fila cuando hay muchas inscripciones)
  const ids = new Set();
  snap.forEach(d => {
    const x = d.data() || {};
    if (x.formId) ids.add(String(x.formId));
  });
  await Promise.all(Array.from(ids).slice(0, 50).map(id => getFormMeta(id)));

  const safeCol = (s) => String(s || "")
    .trim()
    .replace(/[\[\]\.\$#\/]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 60);

  const out = [];
  snap.forEach(d => {
    const x = d.data() || {};
    const meta = formMetaCache.get(String(x.formId || "")) || null;

    const flat = {
      id: d.id,
      createdAt: fmtDate(x.createdAt),
      status: x.status || "",
      formId: x.formId || "",
      formTitle: meta?.title || x.formTitle || "",
    };

    const ans = x.answers || {};
    const used = new Set(Object.keys(flat));

    Object.keys(ans).forEach((k) => {
      const label = meta?.labelById?.[k] || k;
      const baseKey = `ans_${safeCol(label) || safeCol(k)}`;
      let key = baseKey;
      let n = 2;
      while (used.has(key)) {
        key = `${baseKey}_${n++}`;
      }
      used.add(key);
      flat[key] = answerToText(ans[k]);
    });

    out.push(flat);
  });

  return out;
}

// =============================================================
// CONFIG (INSCRIPCIONES PÚBLICO)
// =============================================================
const insEnabledEl = $("#insEnabled");
const insClosedTitleEl = $("#insClosedTitle");
const insClosedMsgEl = $("#insClosedMsg");
const btnSaveInsConfig = $("#btnSaveInsConfig");
const insConfigHint = $("#insConfigHint");

let insConfig = {
  enabled: true,
  closedTitle: "Inscripciones cerradas",
  closedMsg: "Por el momento no tenemos convocatorias abiertas.",
};

btnSaveInsConfig?.addEventListener("click", () => saveInsConfig());

async function loadInsConfig() {
  // No romper si el tab no existe (por ejemplo, si cambias el HTML)
  if (!insEnabledEl) return;

  try {
    const snap = await getDoc(doc(db, "config", "inscripciones"));
    if (snap.exists()) {
      const d = snap.data() || {};
      insConfig = {
        enabled: d.enabled !== false,
        closedTitle: cleanText(d.closedTitle || insConfig.closedTitle, { max: 120, allowNewlines: false }) || insConfig.closedTitle,
        closedMsg: cleanText(d.closedMsg || insConfig.closedMsg, { max: 500, allowNewlines: true }) || insConfig.closedMsg,
      };
    }
  } catch (e) {
    // si no hay reglas/colección aún, no bloquear el admin
    console.warn("No se pudo leer config/inscripciones:", e);
  }

  // Pintar UI
  insEnabledEl.checked = !!insConfig.enabled;
  if (insClosedTitleEl) insClosedTitleEl.value = insConfig.closedTitle || "";
  if (insClosedMsgEl) insClosedMsgEl.value = insConfig.closedMsg || "";
  if (insConfigHint) insConfigHint.textContent = "";
}

async function saveInsConfig() {
  if (!currentUser) return;

  const enabled = !!insEnabledEl?.checked;
  const closedTitle = cleanText(insClosedTitleEl?.value, { max: 120, allowNewlines: false }) || "Inscripciones cerradas";
  const closedMsg = cleanText(insClosedMsgEl?.value, { max: 500, allowNewlines: true }) || "Por el momento no tenemos convocatorias abiertas.";

  const payload = {
    enabled,
    closedTitle,
    closedMsg,
    updatedAt: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, "config", "inscripciones"), payload, { merge: true });
    insConfig = { enabled, closedTitle, closedMsg };
    toast("Configuración guardada.", "success");
    if (insConfigHint) insConfigHint.textContent = "Guardado ✔";
    setTimeout(() => { if (insConfigHint) insConfigHint.textContent = ""; }, 2500);
  } catch (e) {
    console.error(e);
    toast("No se pudo guardar la configuración. Revisa reglas de Firestore.", "danger");
  }
}

// =============================================================
// CONFIG (CONTACTO PÚBLICO)
// - Bloqueo/desbloqueo inmediato usando config/contacto
// =============================================================
const contactEnabledEl = $("#contactEnabled");
const contactClosedTitleEl = $("#contactClosedTitle");
const contactClosedMsgEl = $("#contactClosedMsg");
const btnSaveContactConfig = $("#btnSaveContactConfig");
const contactConfigHint = $("#contactConfigHint");

let contactConfig = {
  enabled: true,
  closedTitle: "Contacto temporalmente cerrado",
  closedMsg: "Por el momento no estamos recibiendo mensajes por este medio. Intenta más tarde.",
};

btnSaveContactConfig?.addEventListener("click", () => saveContactConfig({ showToast: true }));

// Guardado inmediato al activar/desactivar (opcional pero solicitado)
contactEnabledEl?.addEventListener("change", () => saveContactConfig({ showToast: true }));

async function loadContactConfig() {
  if (!contactEnabledEl) return;

  try {
    const snap = await getDoc(doc(db, "config", "contacto"));
    if (snap.exists()) {
      const d = snap.data() || {};
      contactConfig = {
        enabled: d.enabled !== false,
        closedTitle: cleanText(d.closedTitle || contactConfig.closedTitle, { max: 120, allowNewlines: false }) || contactConfig.closedTitle,
        closedMsg: cleanText(d.closedMsg || contactConfig.closedMsg, { max: 500, allowNewlines: true }) || contactConfig.closedMsg,
      };
    }
  } catch (e) {
    console.warn("No se pudo leer config/contacto:", e);
  }

  contactEnabledEl.checked = !!contactConfig.enabled;
  if (contactClosedTitleEl) contactClosedTitleEl.value = contactConfig.closedTitle || "";
  if (contactClosedMsgEl) contactClosedMsgEl.value = contactConfig.closedMsg || "";
  if (contactConfigHint) contactConfigHint.textContent = "";
}

async function saveContactConfig({ showToast = true } = {}) {
  if (!currentUser) return;

  const enabled = !!contactEnabledEl?.checked;
  const closedTitle = cleanText(contactClosedTitleEl?.value, { max: 120, allowNewlines: false }) || "Contacto temporalmente cerrado";
  const closedMsg = cleanText(contactClosedMsgEl?.value, { max: 500, allowNewlines: true }) || "Por el momento no estamos recibiendo mensajes por este medio. Intenta más tarde.";

  const payload = { enabled, closedTitle, closedMsg, updatedAt: serverTimestamp() };

  try {
    await setDoc(doc(db, "config", "contacto"), payload, { merge: true });
    contactConfig = { enabled, closedTitle, closedMsg };
    if (showToast) toast("Configuración de contacto guardada.", "success");
    if (contactConfigHint) contactConfigHint.textContent = "Guardado ✔";
    setTimeout(() => { if (contactConfigHint) contactConfigHint.textContent = ""; }, 2500);
  } catch (e) {
    console.error(e);
    if (showToast) toast("No se pudo guardar la configuración de contacto. Revisa reglas.", "danger");
  }
}

// =============================================================
// PROYECTOS
// =============================================================
const projectsTbody = $("#projectsTbody");
const projectsCount = $("#projectsCount");

$("#btnMoreProjects")?.addEventListener("click", () => loadProjectsPage(false));
$("#btnExportProjects")?.addEventListener("click", async () => {
  const rows = await fetchProjectsForExport(2000);
  exportToXlsx(rows, "fundvisa_proyectos.xlsx", "Proyectos");
});
$("#btnClearProjectForm")?.addEventListener("click", () => clearProjectForm());

$("#projectForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const editId = ($("#pEditId")?.value || "").trim();
  const title = cleanText($("#pTitle")?.value, { max: 120, allowNewlines: false });
  const summary = cleanText($("#pSummary")?.value, { max: 600, allowNewlines: true });
  const impact = cleanText($("#pImpact")?.value, { max: 600, allowNewlines: true });
  const location = cleanText($("#pLocation")?.value, { max: 80, allowNewlines: false });
  const period = cleanText($("#pPeriod")?.value, { max: 60, allowNewlines: false });
  const featured = !!$("#pFeatured")?.checked;
  const active = !!$("#pActive")?.checked;

  const dateStr = ($("#pDate")?.value || "").trim();
  const date = dateStr ? new Date(dateStr + "T00:00:00") : new Date();

  const urlInput = cleanUrl($("#pCoverUrl")?.value);
  const file = $("#pFile")?.files?.[0] || null;

  if (!title) {
    toast("El título es obligatorio.", "warning");
    return;
  }

  const progress = $("#pProgress");
  progress?.classList.add("d-none");
  setProgress(progress, 0);

  let coverUrl = urlInput;
  let coverPath = "";

  try {
    // si edita y no sube nada, conserva cover actual
    if (editId) {
      const old = await getDoc(doc(db, "projects", editId));
      const oldData = old.data() || {};
      coverPath = oldData.coverPath || "";
      if (!coverUrl) coverUrl = oldData.coverUrl || "";
    }

    if (file) {
      const chk = fileOk(file);
      if (!chk.ok) {
        toast(chk.reason, "warning");
        return;
      }
      progress?.classList.remove("d-none");
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase().slice(0, 5);
      coverPath = `projects/${new Date().getFullYear()}/${uid("cover")}.${ext}`;
      const storageRef = ref(storage, coverPath);
      const task = uploadBytesResumable(storageRef, file, { contentType: file.type });

      await new Promise((resolve, reject) => {
        task.on("state_changed", (snap) => {
          const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
          setProgress(progress, pct);
        }, reject, resolve);
      });

      coverUrl = await getDownloadURL(task.snapshot.ref);
    }

    const payload = {
      title,
      summary,
      impact,
      location,
      period,
      featured,
      active,
      coverUrl,
      coverPath,
      date: date, // Firestore guardará como timestamp
      updatedAt: serverTimestamp(),
    };

    if (editId) {
      await updateDoc(doc(db, "projects", editId), payload);
      toast("Proyecto actualizado.", "success");
    } else {
      await addDoc(collection(db, "projects"), {
        ...payload,
        createdAt: serverTimestamp(),
      });
      toast("Proyecto guardado.", "success");
    }

    clearProjectForm();
    await loadProjectsPage(true);
  } catch (err) {
    console.error(err);
    toast("No se pudo guardar el proyecto.", "danger");
  } finally {
    progress?.classList.add("d-none");
  }
});

function clearProjectForm() {
  $("#pTitle").value = "";
  $("#pSummary").value = "";
  $("#pImpact").value = "";
  $("#pLocation").value = "";
  $("#pPeriod").value = "";
  $("#pDate").value = "";
  $("#pFeatured").checked = false;
  $("#pActive").checked = true;
  $("#pCoverUrl").value = "";
  $("#pFile").value = "";
  $("#pEditId").value = "";
}

async function loadProjectsPage(reset) {
  if (!projectsTbody) return;

  if (reset) {
    projectsCursor = null;
    projectsLoaded = 0;
    projectsTbody.innerHTML = "";
  }

  let q = query(collection(db, "projects"), orderBy("updatedAt", "desc"), limit(PAGE_SIZE));
  if (projectsCursor) q = query(collection(db, "projects"), orderBy("updatedAt", "desc"), startAfter(projectsCursor), limit(PAGE_SIZE));

  const snap = await getDocs(q);
  if (!snap.empty) projectsCursor = snap.docs[snap.docs.length - 1];

  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  projectsLoaded += rows.length;

  projectsTbody.insertAdjacentHTML("beforeend", rows.map(renderProjectRow).join(""));
  projectsCount.textContent = `${projectsLoaded} cargados`;

  rows.forEach(r => bindProjectRow(r.id));
}

function renderProjectRow(it) {
  const active = !!it.active;
  const featured = !!it.featured;
  const date = it.date?.toDate ? it.date.toDate().toLocaleDateString("es-CO") : "";
  return `
    <tr id="p_${it.id}">
      <td>
        <div class="fw-semibold">${cleanText(it.title || "", { max: 120, allowNewlines: false })}</div>
        <div class="small text-muted">${featured ? "Destacado" : ""}</div>
      </td>
      <td>${active ? `<span class="badge text-bg-success">Visible</span>` : `<span class="badge text-bg-secondary">Oculto</span>`}</td>
      <td>${date || "—"}</td>
      <td class="text-end">
        <button class="btn btn-outline-primary btn-sm" data-pedit="${it.id}" title="Editar"><i class="fas fa-pen"></i></button>
        <button class="btn btn-outline-danger btn-sm" data-pdel="${it.id}" title="Eliminar"><i class="fas fa-trash"></i></button>
      </td>
    </tr>
  `;
}

function bindProjectRow(id) {
  const row = document.getElementById(`p_${id}`);
  if (!row) return;

  row.querySelector(`[data-pedit="${id}"]`)?.addEventListener("click", async () => {
    const snap = await getDoc(doc(db, "projects", id));
    const it = snap.data() || {};
    $("#pTitle").value = it.title || "";
    $("#pSummary").value = it.summary || "";
    $("#pImpact").value = it.impact || "";
    $("#pLocation").value = it.location || "";
    $("#pPeriod").value = it.period || "";
    $("#pFeatured").checked = !!it.featured;
    $("#pActive").checked = !!it.active;
    $("#pCoverUrl").value = it.coverUrl || "";
    $("#pEditId").value = id;

    if (it.date?.toDate) {
      const d = it.date.toDate();
      const iso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      $("#pDate").value = iso;
    }
    toast("Editando proyecto. Al guardar se actualizará.", "info");
  });

  row.querySelector(`[data-pdel="${id}"]`)?.addEventListener("click", async () => {
    if (!confirm("¿Eliminar este proyecto?")) return;

    try {
      const snap = await getDoc(doc(db, "projects", id));
      const data = snap.data() || {};
      const coverPath = data.coverPath || "";

      await deleteDoc(doc(db, "projects", id));
      if (coverPath) {
        try { await deleteObject(ref(storage, coverPath)); } catch { /* ignore */ }
      }
      toast("Proyecto eliminado.", "success");
      await loadProjectsPage(true);
    } catch (e) {
      console.error(e);
      toast("No se pudo eliminar.", "danger");
    }
  });
}

async function fetchProjectsForExport(maxRows = 2000) {
  const q = query(collection(db, "projects"), orderBy("updatedAt", "desc"), limit(maxRows));
  const snap = await getDocs(q);
  const out = [];
  snap.forEach(d => {
    const x = d.data() || {};
    out.push({
      id: d.id,
      title: x.title || "",
      summary: x.summary || "",
      impact: x.impact || "",
      location: x.location || "",
      period: x.period || "",
      featured: !!x.featured,
      active: !!x.active,
      date: x.date?.toDate ? x.date.toDate().toLocaleDateString("es-CO") : "",
      coverUrl: x.coverUrl || "",
      createdAt: fmtDate(x.createdAt),
      updatedAt: fmtDate(x.updatedAt),
    });
  });
  return out;
}
