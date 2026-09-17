// Sample HTML pages used across tests.

export const nonMinifiedHtml = `<!DOCTYPE html>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <title>Fixture</title>
        <style>
            body { color: red; margin: 0; padding: 0; }
            h1 { font-size: 2rem; }
        </style>
        <script type="application/ld+json">
            {
                "@context": "https://schema.org",
                "@type": "Organization",
                "name": "Fixture Co",
                "url": "https://example.com"
            }
        </script>
        <!-- This is a comment that should be counted. -->
    </head>
    <body class="home" data-page="index" style="background:#fff">
        <h1 class="title" data-role="heading">Hello World</h1>
        <p class="lead">
            Some paragraph content that is not particularly interesting but
            provides a bit of text weight to the document body.
        </p>
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
            <rect width="10" height="10" fill="red"/>
        </svg>
        <script>
            (function () {
                var greeting = "hello";
                console.log(greeting);
            })();
        </script>
    </body>
</html>
`;

export const minifiedHtml =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<title>Fixture</title><style>body{color:red;margin:0;padding:0}h1{font-size:2rem}</style>' +
  '</head><body class="home"><h1>Hello World</h1><p>Body text goes here and is not short so the fixture has some real weight to it.</p></body></html>';

// Fixture for the css-in-body check. Contains exactly:
//   - one <style> in <head> (must not be reported)
//   - one early <style> in <body> with a height rule (High)
//   - one late <style> with only color (Low)
//   - one <style> containing @import (High)
//   - one <style> inside <template> (ignored)
//   - one <link rel="stylesheet"> in <body> (informational)
export const cssInBodyHtml = `<!doctype html>
<html>
<head>
<title>fixture</title>
<style>body{margin:0}</style>
</head>
<body class="page">
<div class="cmp-hero">
<style>.cmp-hero__img{height:400px;width:100%}</style>
<img src="/a.jpg" alt="">
</div>
<template>
<style>.tpl{color:blue}</style>
</template>
<link rel="stylesheet" href="/late.css">
<div class="cmp-later">
<style>@import url("/x.css");</style>
</div>
${Array.from({ length: 40 }, (_, i) => `<p class="cmp-p-${i}">block ${i}</p>`).join('\n')}
<footer id="site-footer">
<style>.cmp-footer p{color:#333}</style>
</footer>
</body>
</html>`;
