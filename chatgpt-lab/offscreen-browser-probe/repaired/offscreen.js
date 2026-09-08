const generation = crypto.randomUUID();
navigator.serviceWorker.addEventListener('message', (event) => {
  if (event.data?.kind !== 'tf-probe') return;
  event.source?.postMessage({
    kind: 'tf-probe-response',
    messageId: event.data.messageId,
    generation,
    href: location.href,
  });
});
