export const createLoadingIndicator = () => {
  const indicator = document.createElement("div");
  indicator.className = "systemsculpt-loading";
  indicator.textContent = "●";
  return indicator;
};
