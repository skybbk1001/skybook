(function () {
  "use strict";

  Theme.loading = {
    register: function () {
      document.querySelectorAll('.loading-wrapper').forEach(el => el.removeAttribute('data-loading'));
      document.querySelectorAll('.page').forEach(el => el.removeAttribute('data-filter'));
    }
  };

  Theme.loading.register();

}.call(this));