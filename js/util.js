function __initUtil(ctx) {

  ctx.rateLimit = function (key, interval) {
    const System = Packages.java.lang.System;
    const Thread = Packages.java.lang.Thread;
    const AtomicLong = Packages.java.util.concurrent.atomic.AtomicLong;

    const props = System.getProperties();
    const timer = props.computeIfAbsent(
      key,
      () => new AtomicLong(0)
    );

    while (true) {
      let now = System.currentTimeMillis();
      let last = timer.get();
      let elapsed = now - last;

      if (elapsed >= interval && timer.compareAndSet(last, now)) return;

      let wait = interval - elapsed + 20;
      Thread.sleep(wait > 0 ? Math.min(wait, 500) : 20);
    }
  };

}