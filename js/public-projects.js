// FUNDVISA - Proyectos (público) - Estilo Blog Interactivo
import { db } from "./firebase.js";
import { $, escapeHtml, toast } from "./utils.js";
import { collection, getDocs, query, where, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

(function initProjects() {
  // Referencias a elementos del DOM
  const grid = $("#fvProjectsGrid");
  const detailView = $("#fvProjectDetail");
  const loader = $("#fvProjectsLoader");
  const empty = $("#fvProjectsEmpty");
  const btnBack = $("#btnBackToGrid");

  // Variables para guardar los datos cargados
  let loadedProjects = [];

  if (!grid) return;

  // Configuración del botón "Volver"
  if (btnBack) {
    btnBack.addEventListener("click", () => {
      toggleView("grid");
    });
  }

  const q = query(
    collection(db, "projects"),
    where("active", "==", true),
    orderBy("featured", "desc"),
    orderBy("date", "desc"),
    limit(50)
  );

  (async () => {
    try {
      loader?.classList.remove("d-none");
      const snap = await getDocs(q);
      
      if (snap.empty) {
        empty?.classList.remove("d-none");
        loader?.classList.add("d-none");
        return;
      }

      // Guardamos los datos en memoria para no volver a consultar al hacer click
      loadedProjects = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      
      renderGrid(loadedProjects);

      // Si viene un proyecto en la URL (ej: proyectos.html?project=ABC), abrir detalle automáticamente
      maybeOpenFromUrl();

    } catch (err) {
      console.error(err);
      toast("No se pudieron cargar los proyectos.", "danger");
    } finally {
      loader?.classList.add("d-none");
    }
  })();

  // --- Funciones de Renderizado ---

  function renderGrid(projects) {
    grid.innerHTML = projects.map(item => {
      // Usamos datos básicos para la tarjeta
      const title = escapeHtml(item.title || "Proyecto");
      const summary = escapeHtml(item.summary || "Ver detalles...");
      const location = escapeHtml(item.location || "");
      const period = escapeHtml(item.period || "");
      const coverUrl = item.coverUrl ? escapeHtml(item.coverUrl) : 'img/project-placeholder.jpg';
      
      const badge = item.featured 
        ? `<div class="badge-featured"><i class="fas fa-star me-1"></i> Destacado</div>` 
        : "";

      let metaHtml = '';
      if (location) metaHtml += `<span><i class="fas fa-map-marker-alt"></i> ${location}</span>`;
      
      // NOTA: Agregamos data-id al div contenedor para identificar el click
      return `
        <div class="col-12 col-md-6 col-lg-4 d-flex align-items-stretch">
          <article class="project-card h-100 w-100" data-id="${item.id}">
            <div class="project-cover-wrapper">
               ${badge}
               <img src="${coverUrl}" alt="${title}" loading="lazy" onerror="this.src='https://via.placeholder.com/600x400?text=FUNDVISA'">
            </div>
            
            <div class="project-body">
              <div class="project-meta">${metaHtml}</div>
              <h3 class="project-title">${title}</h3>
              <p class="project-desc">${summary}</p>
              <div class="mt-auto text-end">
                 <span class="text-success fw-bold small">Leer más <i class="fas fa-arrow-right ms-1"></i></span>
              </div>
            </div>
          </article>
        </div>
      `;
    }).join("");

    // Agregar eventos de click a las tarjetas generadas
    document.querySelectorAll('.project-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.getAttribute('data-id');
        const projectData = loadedProjects.find(p => p.id === id);
        if (projectData) {
          showProjectDetails(projectData);
        }
      });
    });
  }

  function showProjectDetails(item) {
    // 1. Rellenar los campos del detalle
    const coverEl = $("#detailCover");
    const titleEl = $("#detailTitle");
    const metaEl = $("#detailMeta");
    const bodyEl = $("#detailBody");
    const badgeEl = $("#detailBadge");
    const impactBox = $("#detailImpact");
    const impactText = $("#detailImpactText");

    // Imagen (si no tiene, poner placeholder)
    coverEl.src = item.coverUrl || 'img/project-placeholder.jpg';
    coverEl.onerror = () => { coverEl.src = 'https://via.placeholder.com/1200x600?text=FUNDVISA'; };
    
    titleEl.textContent = item.title || "Sin título";
    
    // Metadatos (Fecha y Lugar)
    metaEl.innerHTML = `
        ${item.period ? `<span class="me-3"><i class="far fa-calendar-alt me-1"></i> ${escapeHtml(item.period)}</span>` : ''}
        ${item.location ? `<span><i class="fas fa-map-marker-alt me-1"></i> ${escapeHtml(item.location)}</span>` : ''}
    `;

    // Badge
    if (item.featured) {
        badgeEl.classList.remove('d-none');
    } else {
        badgeEl.classList.add('d-none');
    }

    // Contenido (Descripción larga si existe, sino summary)
    // Nota: Si tienes un campo 'content' o 'description' largo en Firebase, úsalo aquí. 
    // Si solo tienes 'summary', usa ese. Asumiré que podrías tener 'description' o usamos 'summary'.
    const fullContent = item.description || item.summary || "";
    bodyEl.textContent = fullContent; // textContent escapa HTML automáticamente, seguro para XSS.
    
    // Impacto
    if (item.impact) {
        impactBox.classList.remove('d-none');
        impactText.textContent = item.impact;
    } else {
        impactBox.classList.add('d-none');
    }

    // 2. Cambiar vista
    toggleView("detail");
    
    // 3. Scroll arriba suavemente
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }


  function maybeOpenFromUrl() {
    try {
      const p = new URLSearchParams(window.location.search);
      const id = p.get("project") || p.get("id") || p.get("p");
      if (!id) return;
      const it = loadedProjects.find(x => String(x.id) === String(id));
      if (it) showProjectDetails(it);
    } catch { /* ignore */ }
  }

  function toggleView(viewName) {
    if (viewName === "detail") {
      grid.classList.add("d-none");
      detailView.classList.remove("d-none");
    } else {
      detailView.classList.add("d-none");
      grid.classList.remove("d-none");
      // Scroll al inicio de la lista de proyectos
      document.querySelector('.page-hero').scrollIntoView({ behavior: 'smooth' });
    }
  }

})();