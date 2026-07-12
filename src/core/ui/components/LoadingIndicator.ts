export const createLoadingIndicator = () => {
  const indicator = createDiv();
  indicator.className = "systemsculpt-loading";
  indicator.textContent = "●";
  return indicator;
};
