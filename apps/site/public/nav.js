// The nav's glass shows once the page scrolls.
const nav = document.querySelector(".nav");
const stick = () => nav.classList.toggle("stuck", scrollY > 8);
addEventListener("scroll", stick, { passive: true });
stick();
