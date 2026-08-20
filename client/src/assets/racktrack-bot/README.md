# RackTrack mascot

The robot from the "From manual audits to verified infrastructure" walkthrough
on the home page, lifted out so the application can use the same character.

It is drawn in SVG - there is no image file and no chat-widget library behind
it. The original lives inline in `src/pages/index.html` with its animation in
`src/css/page/index.css`; this folder is the portable copy.

```
racktrack-bot.svg   the mascot, animated, self-contained
demo.html           open this to see it on light and dark at four sizes
```

## Use it

```html
<img src="racktrack-bot.svg" width="88" alt="">
```

That is the whole integration. The animation is declared inside the SVG, so it
plays as an `<img>`, as a CSS `background-image`, or inlined - no stylesheet
and no script to import.

React is the same idea:

```jsx
import bot from "./racktrack-bot.svg";
<img src={bot} width={88} alt="" />
```

Set a width and the height follows from the 148&times;168 viewBox. Keep
`alt=""` when it sits next to text that already says the same thing, so screen
readers do not announce it twice.

## What changed from the site version

- **Gradient ids are prefixed `rtb-`.** Ids in an inlined SVG are global to the
  page. The site version uses bare names like `bArm`, so two copies on one
  screen would make the second silently repaint the first.
- **The animation moved inside the file.** On the site it sits in the page
  stylesheet and is gated on a `.js` class, which is site plumbing the app does
  not have.
- **The site's positioning is gone.** It was `position: absolute` with a
  `z-index`, pinned to the walkthrough panel. Here it is a plain inline image
  and the caller decides where it goes.
- **It is no longer hidden on phones.** The site sets `display: none` below
  768px because the mascot overlapped its own callout on a narrow screen. That
  is a home page layout problem, not a property of the mascot - if you float it
  over content in the app, give it a lane rather than hiding it.
- **`prefers-reduced-motion` is respected**, so it holds still for anyone who
  asked their OS for less movement.

Nothing about the drawing itself changed - same paths, same gradients, same
four movements (float, wave, point, shadow).

## Both light and dark

There is one file. The body is white and the ground shadow is a soft navy at
low opacity, so it reads on either background - no second asset to keep in
sync. `demo.html` shows it on both.
