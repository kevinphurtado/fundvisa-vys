// FUNDVISA - Index (Home) - Proyectos destacados + últimas 4 fotos
import { db } from "./firebase.js";
import { collection, getDocs, query, where, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

(function initHomeDynamic() {
  const projIndicators = document.getElementById("fvIdxProjectsIndicators");
  const projInner = document.getElementById("fvIdxProjectsInner");
  const projLoader = document.getElementById("fvIdxProjectsLoader");
  const projEmpty = document.getElementById("fvIdxProjectsEmpty");

  const galGrid = document.getElementById("fvIdxGalleryGrid");
  const galLoader = document.getElementById("fvIdxGalleryLoader");
  const galEmpty = document.getElementById("fvIdxGalleryEmpty");

  const carouselEl = document.getElementById("carouselProyectos");

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const show = (el) => el && el.classList.remove("d-none");
  const hide = (el) => el && el.classList.add("d-none");

  // ---------- PROYECTOS DESTACADOS ----------
  /**
   * Función auxiliar para recortar texto de forma inteligente.
   * Corta en el último espacio disponible antes del límite para no cortar palabras a la mitad.
   */
  function recortarTexto(texto, maxChars = 100) {
    if (!texto) return "Sin descripción disponible.";
    if (texto.length <= maxChars) return texto;
    
    // Cortar al límite
    let sub = texto.substr(0, maxChars);
    // Retroceder hasta el último espacio para no cortar una palabra (ej: "progra...")
    return sub.substr(0, Math.min(sub.length, sub.lastIndexOf(" "))) + "...";
  }

  async function loadFeaturedProjects() {
    if (!projIndicators || !projInner || !carouselEl) return;

    show(projLoader); 
    hide(projEmpty);

    // Intentos de Query (Mantenemos tu lógica de índices)
    const tryQueries = [
      () => query(collection(db, "projects"), where("active", "==", true), where("featured", "==", true), orderBy("date", "desc"), limit(9)),
      () => query(collection(db, "projects"), where("active", "==", true), where("featured", "==", true), orderBy("updatedAt", "desc"), limit(9)),
      () => query(collection(db, "projects"), where("active", "==", true), where("featured", "==", true), orderBy("createdAt", "desc"), limit(9)),
    ];

    let docs = [];
    for (const makeQ of tryQueries) {
      try {
        const snap = await getDocs(makeQ());
        docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (docs.length > 0) break; // Si encontramos datos, paramos
      } catch (e) {
        console.warn("Intento de query fallido (posible falta de índice):", e.code);
      }
    }

    hide(projLoader);

    if (!docs.length) {
      show(projEmpty);
      projIndicators.innerHTML = "";
      projInner.innerHTML = "";
      return;
    }

    // Render: Agrupar de 3 en 3 para el Carousel
    const chunkSize = 3;
    const slides = [];
    for (let i = 0; i < docs.length; i += chunkSize) {
      slides.push(docs.slice(i, i + chunkSize));
    }

    // Generar Indicadores (puntitos abajo)
    projIndicators.innerHTML = slides.map((_, i) => `
      <button type="button" data-bs-target="#carouselProyectos" data-bs-slide-to="${i}" 
        class="${i === 0 ? "active" : ""}" 
        ${i === 0 ? 'aria-current="true"' : ""} 
        aria-label="Slide ${i + 1}"></button>
    `).join("");

    // Generar Slides (Items del carousel)
    projInner.innerHTML = slides.map((group, idx) => `
      <div class="carousel-item ${idx === 0 ? "active" : ""}">
        <div class="row g-4">
          ${group.map(renderProjectCard).join("")}
        </div>
      </div>
    `).join("");

    // Controlar visibilidad de flechas (si solo hay 1 slide, no se muestran)
    const prev = carouselEl.querySelector(".carousel-control-prev");
    const next = carouselEl.querySelector(".carousel-control-next");
    if (slides.length <= 1) {
      prev?.classList.add("d-none");
      next?.classList.add("d-none");
    } else {
      prev?.classList.remove("d-none");
      next?.classList.remove("d-none");
    }
  }

  /**
   * Renderiza la tarjeta individual.
   * Aplica recorte de texto y estilos mejorados.
   */
  function renderProjectCard(it) {
    const title = esc(it.title || "Proyecto sin título");
    
    // 1. Obtenemos el texto crudo
    const rawSummary = it.summary || "";
    
    // 2. Recortamos a un máximo seguro (ej: 120 caracteres) para el HTML
    const shortSummary = recortarTexto(rawSummary, 120);

    const img = esc(it.coverUrl || "img/project-placeholder.jpg");
    const href = `proyectos.html?project=${encodeURIComponent(it.id)}`;

    return `
      <div class="col-lg-4 col-md-6">
        <div class="card project-card h-100 border-0 shadow-sm hover-elevate">
          <div class="position-relative overflow-hidden" style="height: 200px;">
            <img src="${img}" class="card-img-top w-100 h-100 object-fit-cover" alt="${title}" loading="lazy" onerror="this.src='img/project-placeholder.jpg'">
          </div>
          
          <div class="card-body p-4 d-flex flex-column">
            <h5 class="card-title fw-bold mb-3 text-truncate" title="${title}" style="color: var(--color-azul);">
              ${title}
            </h5>
            
            <p class="card-text text-muted small flex-grow-1 text-clamp-3 mb-4">
              ${esc(shortSummary)}
            </p>
            
            <div class="mt-auto">
              <a href="${href}" class="btn btn-outline-success btn-sm rounded-pill px-4 fw-semibold">
                Ver completo <i class="fas fa-arrow-right ms-1"></i>
              </a>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ---------- GALERÍA (ÚLTIMAS 4) ----------
  async function loadLatestGallery() {
    if (!galGrid) return;

    show(galLoader); hide(galEmpty);

    const tryQueries = [
      () => query(
        collection(db, "gallery"),
        where("active", "==", true),
        orderBy("createdAt", "desc"),
        limit(4)
      ),
      () => query(
        collection(db, "gallery"),
        where("active", "==", true),
        orderBy("updatedAt", "desc"),
        limit(4)
      ),
      // fallback si no hay índice con where+orderBy
      () => query(
        collection(db, "gallery"),
        orderBy("createdAt", "desc"),
        limit(6)
      ),
    ];

    let items = [];
    for (const makeQ of tryQueries) {
      try {
        const snap = await getDocs(makeQ());
        items = snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .filter(x => x.active !== false) // por si entró el fallback sin where
          .slice(0, 4);
        break;
      } catch (e) {
        console.warn("Query gallery falló (probable índice):", e?.code || e);
      }
    }

    hide(galLoader);

    if (!items.length) {
      show(galEmpty);
      galGrid.innerHTML = "";
      return;
    }

    galGrid.innerHTML = items.map(renderGalleryItem).join("");
  }

  function renderGalleryItem(it) {
    const url = esc((it.imageUrl || "").trim());
    const cap = esc((it.caption || "Galería").trim());
    if (!url) return "";

    return `
      <div class="gallery-item" data-bs-toggle="modal" data-bs-target="#lightboxModal" data-img="${url}">
        <img src="${url}" alt="${cap}" class="gallery-img" loading="lazy">
        <div class="gallery-overlay">
          <i class="fas fa-search-plus fa-3x text-white"></i>
        </div>
      </div>
    `;
  }

  // Ejecutar
  loadFeaturedProjects();
  loadLatestGallery();
})();
