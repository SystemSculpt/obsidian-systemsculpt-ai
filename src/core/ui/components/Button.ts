export const createButton = (
  text: string,
  onClick: () => void,
  className = ""
) => {
  const button = document.createElement("button");
  button.className = `ss-button ${className}`;
  button.textContent = text;
  button.onclick = onClick;
  return button;
};
