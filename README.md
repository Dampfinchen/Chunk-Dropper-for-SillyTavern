Update:

See changelogs. Context compaction works now. Give it a few turns to settle. It currently needs more reprocessing due to a bug, but after that it should work.


Vibe coded and alpha. Many things don't work.

This is an extension that was written by Gemini.

What does it do? Once Silly Tavern is above max context, it maintains a rolling chat window by deleting the oldest messages bit by bit with every reply. 

Now, since context shift won't work with Gemma 4 or Qwen 3.5 due to their architectures, you have to reprocess the entire prompt with every message, which can take a lot of time depending on how long your context, how big your model and how capable your hardware is. To put it simply, you might have to wait a long time for the AI to respond again with every message.

This extension fixes this. When approaching max context, it will delete a huge chunk of your context. After processing that, you will be free of having to reprocess the prompt for quite a long while (again depending on your context). 

The downside is memory loss, however since you are able to use hybrid models with more context than ever before, you would still have much better memory than with older models where context shift worked. With the amount of chunks dropped, you can set this for yourself.

A drop amount of 90% means you are going to lose pretty much all of the context. -> prompt reprocessing is a long way off!

A drop amount of 10% means you are not going to lose much at all, but prompt reprocessing needs to be done a few turns down the line again. 

I recommend the default value of 40%. You are still going to have most of the context and still can enjoy a rolling chat window without having to reprocess all the time.

The threshold is calculated using your max context and response token length setting, automatically (if that is enabled.)

Right now, the feature doesn't work but for the ultimate solution, this extension features context compaction (or, rather is supposed to.) Similar to Agentic Software like Hermes Agent or OpenCode, before dropping the cunk of context, it would summarize what happened in chat and then attend that to the system prompt or somewhere else in the context.

This way, the model would not lose previous memories. But yeah, that doesn't work. It requires a deeper understanding how Silly Tavern works. 

Installation:

Very simple! Put the rnn compactor folder in SillyTavern\public\scripts\extensions\third-party 

After that, make sure to enable the extension in the extension configuration menu. It should work out of the box.

Needs a lot of testing though but from my first tests, it works great (atleast the chunk dropping part)

Enjoy Qwen 3.5 and Gemma 4 with a rolling chat window!



