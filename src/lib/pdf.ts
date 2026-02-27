export async function renderPdfToImages(
  file: File,
  maxDim: number = 2048,
  quality: number = 0.85
): Promise<string[]> {
  const pdfjsLib = await import("pdfjs-dist");

  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const images: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });

    const scale = Math.min(
      maxDim / viewport.width,
      maxDim / viewport.height,
      2
    );
    const scaledViewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;
    const ctx = canvas.getContext("2d")!;

    await page.render({ canvasContext: ctx, canvas, viewport: scaledViewport })
      .promise;
    images.push(canvas.toDataURL("image/jpeg", quality));
  }

  return images;
}

/** Check if a data URL image is mostly blank (white/light pixels) */
export function isImageBlank(dataUrl: string, threshold = 0.97): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const sampleHeight = Math.min(img.height, 200);
      canvas.width = img.width;
      canvas.height = sampleHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, img.width, sampleHeight, 0, 0, img.width, sampleHeight);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let lightPixels = 0;
      const totalPixels = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 230 && data[i + 1] > 230 && data[i + 2] > 230) {
          lightPixels++;
        }
      }
      resolve(lightPixels / totalPixels > threshold);
    };
    img.onerror = () => resolve(false);
    img.src = dataUrl;
  });
}

export function cropQuestionFromPage(
  pageDataUrl: string,
  yStartPct: number,
  yEndPct: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const yStart = Math.floor((yStartPct / 100) * img.height);
      const yEnd = Math.ceil((yEndPct / 100) * img.height);
      const cropHeight = yEnd - yStart;

      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = cropHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(
        img,
        0,
        yStart,
        img.width,
        cropHeight,
        0,
        0,
        img.width,
        cropHeight
      );
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = pageDataUrl;
  });
}
