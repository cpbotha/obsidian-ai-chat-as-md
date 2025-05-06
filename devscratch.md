# dev scratchpad

## give progress feedback during long image generation calls

With `setInterval()` I could make progress / busy indicator on the statusbar.

```typescript
const startSecs = Date.now() / 1000;
let intervalId: NodeJS.Timeout | null = null;
let imgResp;

try {
    // Start progress logging
    intervalId = setInterval(() => {
        const elapsed = Math.round(Date.now() / 1000 - startSecs);
        console.log(`... operation in progress for ${elapsed} seconds`);
    }, 10000); // Log every 10 seconds

    // Initiate and await the OpenAI call
    if (images.length > 0) {
        console.log("requesting image EDIT");
        imgResp = await openai.images.edit({
            image: images,
            ...options,
        } as OpenAI.Images.ImageEditParams);
    } else {
        console.log("requesting image GENERATION");
        imgResp = await openai.images.generate(
            options as OpenAI.Images.ImageGenerateParams
        );
    }

    // Process result (optional, belongs after finally if result needed outside)
    const b64_json = imgResp.data?.[0].b64_json;
    console.log("b64_json.length ===> ", b64_json?.length);

} catch (error) {
    console.error("Error during OpenAI operation:", error);
    // Handle or rethrow error as needed
} finally {
    // Stop progress logging
    if (intervalId) {
        clearInterval(intervalId);
    }
    const endSecs = Date.now() / 1000;
    const duration = Math.round(endSecs - startSecs);
    console.log(`Operation finished in ${duration} seconds.`);
}

// Access imgResp here if needed (check for undefined if errors occurred)
```
