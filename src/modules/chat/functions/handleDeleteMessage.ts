export function handleDeleteMessage(
  deleteButton: HTMLElement,
  confirmDelete: () => void
) {
  if (deleteButton.classList.contains('confirm-delete')) {
    confirmDelete();
  } else {
    deleteButton.classList.add('confirm-delete');
    deleteButton.innerHTML = 'You sure? 🗑️';
    setTimeout(() => {
      deleteButton.classList.remove('confirm-delete');
      deleteButton.innerHTML = '🗑️';
    }, 3000);
  }
}
