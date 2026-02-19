(function () {
  "use strict";

  const navbar = document.getElementsByClassName('head')[0];
  const menubar = document.getElementById('menubar');

  function getScrollTop() {
    return window.scrollY || document.documentElement.scrollTop;
  }

  Theme.navbar = {
    register() {
      this.registerScroll();
      this.registerButton();
    },
    registerScroll() {
      let scrollHeight = getScrollTop();

      document.addEventListener('scroll', debounce(function () {
        let newScrollTop = getScrollTop();
        if (!menubar.getAttribute('data-show')) {
          if (scrollHeight + 50 > newScrollTop)
            navbar.setAttribute('data-show', 'true');
          else
            navbar.removeAttribute('data-show');

          scrollHeight = newScrollTop;
        }
      }, 100));
    },
    registerButton() {
      const toggleButton = document.getElementById('bar-wrap-toggle');
      toggleButton.addEventListener('click', function () {
        if (menubar.getAttribute('data-show'))
          menubar.removeAttribute('data-show')
        else
          menubar.setAttribute('data-show', true);
      })
    }
  };
}.call(this));
