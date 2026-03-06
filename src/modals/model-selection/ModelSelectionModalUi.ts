import { EmptyFavoritesState } from "../../components/EmptyFavoritesState";
import { ListSelectionModal } from "../../core/ui/modals/standard";
import { FavoritesService } from "../../services/FavoritesService";

export function updateModelSelectionFavoritesButtonCount(
  modalInstance: ListSelectionModal | null,
  favoritesCount: number
): void {
  const favoritesEl = modalInstance?.contentEl.querySelector(".systemsculpt-favorites-filter");
  if (!favoritesEl) {
    return;
  }

  favoritesEl.querySelector(".ss-favorites-count")?.remove();
  if (favoritesCount > 0) {
    const countEl = favoritesEl.createSpan("ss-favorites-count");
    countEl.textContent = String(favoritesCount);
  }
}

export function updateModelSelectionEmptyState(options: {
  modalInstance: ListSelectionModal | null;
  emptyState: EmptyFavoritesState | null;
  favoritesService: FavoritesService;
  filteredCount: number;
}): EmptyFavoritesState | null {
  const { modalInstance, favoritesService, filteredCount } = options;
  if (!modalInstance) {
    return options.emptyState;
  }

  const modalContent = modalInstance.contentEl;
  const listEl = modalContent.querySelector(".ss-modal__list");

  if (filteredCount === 0) {
    const nextEmptyState =
      options.emptyState ||
      new EmptyFavoritesState(modalContent, favoritesService.getShowFavoritesOnly());
    nextEmptyState.updateForFilterState(favoritesService.getShowFavoritesOnly());
    modalContent.appendChild(nextEmptyState.element);
    listEl?.addClass("systemsculpt-hidden");
    return nextEmptyState;
  }

  options.emptyState?.element.detach();
  listEl?.removeClass("systemsculpt-hidden");
  return options.emptyState;
}
