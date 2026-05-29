import { jsPDF } from 'jspdf';

export const downloadFile = (content: string | Blob, filename: string, mimeType: string) => {
  const blob = typeof content === 'string' ? new Blob([content], { type: mimeType }) : content;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

export const handleDownloadMD = (text: string) => {
  downloadFile(text, 'report.md', 'text/markdown;charset=utf-8');
};

export const handleDownloadPDF = (text: string) => {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 15;
  const usableWidth = pageWidth - 2 * margin;

  const fontSize = 12;
  doc.setFontSize(fontSize);
  const lineHeight = 7;

  const lines = doc.splitTextToSize(text, usableWidth);
  let y = margin;

  for (let i = 0; i < lines.length; i++) {
    if (y > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
    doc.text(lines[i], margin, y);
    y += lineHeight;
  }

  doc.save('report.pdf');

  //   const pdfBlob = doc.output("blob");
  //   downloadFile(pdfBlob, "report.pdf", "application/pdf");
};

export const handleDownloadDOC = (text: string) => {
  const htmlContent = `
    <html xmlns:o='urn:schemas-microsoft-com:office:office'
          xmlns:w='urn:schemas-microsoft-com:office:word'
          xmlns='http://www.w3.org/TR/REC-html40'>
      <head>
        <meta charset='utf-8'>
        <title>Report</title>
      </head>
      <body>
        <pre style="font-family: Consolas, monospace; white-space: pre-wrap;">${text}</pre>
      </body>
    </html>
  `;

  const blob = new Blob(['\ufeff', htmlContent], {
    type: 'application/msword',
  });

  downloadFile(blob, 'report.doc', 'application/msword');
};
