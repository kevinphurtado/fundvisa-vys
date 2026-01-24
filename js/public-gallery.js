// FUNDVISA - Galería (público) por Álbumes
import { db } from "./firebase.js";
import { $, escapeHtml, toast } from "./utils.js";
import { collection, getDocs, orderBy, query, where, limit } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

(function initGalleryAlbums() {
  const grid = $("#fvGalleryGrid");
  const empty = $("#fvGalleryEmpty");
  const loader = $("#fvGalleryLoader");

  const viewLabel = $("#fvGalleryViewLabel");
  const viewTitle = $("#fvGalleryViewTitle");
  const backBtn = $("#fvGalleryBack");

  if (!grid) return;

  const ALBUMS_COL = "galleryAlbums";
  const PHOTOS_SUB = "photos";

  let currentAlbumId = "";
  let currentAlbumTitle = "";

  // Carga inicial: álbumes
  loadAlbums();

  backBtn?.addEventListener("click", () => {
    currentAlbumId = "";
    currentAlbumTitle = "";
    backBtn.classList.add("d-none");
    if (viewLabel) viewLabel.textContent = "Álbumes";
    if (viewTitle) viewTitle.textContent = "Galería";
    loadAlbums();
  });

  async function loadAlbums() {
    try {
      empty?.classList.add("d-none");
      loader?.classList.remove("d-none");

      const q = query(
        collection(db, ALBUMS_COL),
        where("active", "==", true),
        orderBy("order", "asc"),
        orderBy("createdAt", "desc"),
        limit(80)
      );

      const snap = await getDocs(q);

      if (snap.empty) {
        grid.innerHTML = "";
        empty?.classList.remove("d-none");
        return;
      }

      const albums = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      grid.innerHTML = albums.map(renderAlbumCard).join("");

      // Bind clicks
      grid.querySelectorAll("[data-album]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.getAttribute("data-album") || "";
          const title = btn.getAttribute("data-title") || "Álbum";
          if (!id) return;
          await loadAlbumPhotos(id, title);
        });
      });
    } catch (err) {
      console.error(err);
      toast("No se pudo cargar la galería.", "danger");
    } finally {
      loader?.classList.add("d-none");
    }
  }

  async function loadAlbumPhotos(albumId, title) {
    try {
      currentAlbumId = albumId;
      currentAlbumTitle = title;

      backBtn?.classList.remove("d-none");
      if (viewLabel) viewLabel.textContent = "Álbum";
      if (viewTitle) viewTitle.textContent = title || "Álbum";

      empty?.classList.add("d-none");
      loader?.classList.remove("d-none");

      const q = query(
        collection(db, ALBUMS_COL, albumId, PHOTOS_SUB),
        where("active", "==", true),
        orderBy("order", "asc"),
        orderBy("createdAt", "desc"),
        limit(240)
      );

      const snap = await getDocs(q);

      if (snap.empty) {
        grid.innerHTML = `
          <div class="col-12">
            <div class="bg-white rounded-4 shadow-sm p-4 text-center">
              <div class="text-secondary opacity-25 mb-2"><i class="fas fa-images fa-3x"></i></div>
              <h5 class="fw-bold text-secondary mb-1">Este álbum aún no tiene fotos publicadas</h5>
              <p class="text-muted small mb-0">Vuelve más tarde para ver nuevas actualizaciones.</p>
            </div>
          </div>
        `;
        return;
      }

      const items = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(it => /^https?:\/\//i.test(String(it.imageUrl || "").trim()));
      grid.innerHTML = items.map(renderPhotoCard).join("");
      wireModal();
    } catch (err) {
      console.error(err);
      toast("No se pudo cargar el álbum.", "danger");
    } finally {
      loader?.classList.add("d-none");
    }
  }

  function renderAlbumCard(a) {
    const id = String(a.id || "").trim();
    const title = String(a.title || "Álbum").trim();
    const desc = String(a.desc || "").trim();
    const coverUrl = String(a.coverUrl || "").trim();
    const count = Number.isFinite(a.photosCount) ? a.photosCount : (a.photosCount ? Number(a.photosCount) : 0);

    const safeId = escapeHtml(id);
    const safeTitle = escapeHtml(title);
    const safeDesc = escapeHtml(desc);
    const safeCover = escapeHtml(coverUrl || "img/placeholder.jpg");
    
    return `
      <div class="col-12 col-sm-6 col-lg-4">
        <button class="fv-gallery-card" type="button" data-album="${safeId}" data-title="${safeTitle}">
          <div class="fv-gallery-thumb">
            <span class="fv-album-badge">${escapeHtml(String(count || 0))} fotos</span>
            <img src="${safeCover}" alt="${safeTitle}" loading="lazy" />
          </div>
          <div class="fv-gallery-meta">
            <div class="fv-gallery-cap">${safeTitle}</div>
            ${safeDesc ? `<div class="fv-gallery-date">${safeDesc}</div>` : ""}
          </div>
        </button>
      </div>
    `;
  }

  function renderPhotoCard(it) {
    const url = String(it.imageUrl || "").trim();
    const caption = String(it.caption || "").trim();
    const date = it.createdAt?.toDate ? it.createdAt.toDate().toLocaleDateString("es-CO") : "";
    const safeCap = escapeHtml(caption || "Imagen");
    const safeDate = escapeHtml(date);
    const safeUrl = escapeHtml(url);

    if (!url) return "";

    return `
      <div class="col-12 col-sm-6 col-lg-4">
        <button class="fv-gallery-card" type="button"
          data-bs-toggle="modal" data-bs-target="#fvGalleryModal"
          data-img="${safeUrl}" data-cap="${safeCap}" data-date="${safeDate}">
          <div class="fv-gallery-thumb">
            <img src="${safeUrl}" alt="${safeCap}" loading="lazy" />
          </div>
          <div class="fv-gallery-meta">
            <div class="fv-gallery-cap">${safeCap}</div>
            ${safeDate ? `<div class="fv-gallery-date">${safeDate}</div>` : ""}
          </div>
        </button>
      </div>
    `;
  }

  function wireModal() {
    const modal = $("#fvGalleryModal");
    if (!modal) return;

    const img = $("#fvGalleryModalImg");
    const cap = $("#fvGalleryModalCap");
    const date = $("#fvGalleryModalDate");

    // Evita múltiples listeners si se re-renderiza
    modal.dataset.wired = modal.dataset.wired || "0";
    if (modal.dataset.wired === "1") return;
    modal.dataset.wired = "1";

    modal.addEventListener("show.bs.modal", (ev) => {
      const btn = ev.relatedTarget;
      const url = btn?.getAttribute("data-img") || "";
      const c = btn?.getAttribute("data-cap") || "";
      const d = btn?.getAttribute("data-date") || "";
      if (img) img.src = url;
      if (cap) cap.textContent = c;
      if (date) date.textContent = d;
    });

    modal.addEventListener("hidden.bs.modal", () => {
      if (img) img.src = "";
    });
  }
})();
