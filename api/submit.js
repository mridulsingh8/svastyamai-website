export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Get the Google Script URL securely from Vercel's Environment Variables or local .env
  const scriptUrl = process.env.GOOGLE_SCRIPT_URL;

  if (!scriptUrl) {
    return res.status(500).json({ error: 'Server misconfiguration: missing URL' });
  }

  try {
    // We forward the request as a typical URL Encoded form POST 
    // which is what Google Apps script handles best.
    const response = await fetch(scriptUrl, {
      method: 'POST',
      body: new URLSearchParams(req.body),
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error submitting to Google Sheet:", error);
    return res.status(500).json({ error: 'Failed to submit' });
  }
}
