import { GitStatus, CommitMessage } from './types.js';
import { getModelConfig, ModelConfig } from './config.js';
import fetch from 'node-fetch';

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

interface OllamaResponse {
  response: string;
  model: string;
  created_at: string;
  done: boolean;
}

async function generateWithOllama(prompt: string, modelConfig: ModelConfig): Promise<string> {
  const isDeepseek = modelConfig.name.includes('deepseek');
  
  const response = await fetch(modelConfig.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelConfig.name,
      prompt: prompt,
      stream: !isDeepseek, // Disable streaming for deepseek
      options: {
        temperature: modelConfig.temperature,
        top_p: modelConfig.topP
      }
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  if (isDeepseek) {
    // For deepseek, handle non-streaming response
    const data = await response.json() as OllamaResponse;
    return data.response;
  } else {
    // For other models, handle streaming response
    if (!response.body) {
      throw new Error('No response body received');
    }

    let fullMessage = '';
    for await (const chunk of response.body) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          if (json.response) {
            fullMessage += json.response;
          }
        } catch (e) {
          // Ignore parsing errors for incomplete chunks
        }
      }
    }
    return fullMessage;
  }
}

async function generateWithOpenAI(prompt: string, modelConfig: ModelConfig): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OpenAI API key not found in environment variables');
  }

  const response = await fetch(modelConfig.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      temperature: modelConfig.temperature,
      top_p: modelConfig.topP,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error! status: ${response.status}`);
  }

  const data = await response.json() as OpenAIResponse;
  return data.choices[0].message.content;
}

export async function generateCommitMessage(status: GitStatus, modelName?: string): Promise<CommitMessage> {
  try {
    const modelConfig = getModelConfig(modelName);
    console.log(`Connecting to ${modelConfig.name} API...`);
    
    const filesInfo = Object.entries(status.files)
      .map(([file, content]) => {
        const diffLines = content.diff.split('\n');
        const removedLines = diffLines
          .filter(line => line.startsWith('-'))
          .map(line => line.substring(1))
          .join('\n');
        const addedLines = diffLines
          .filter(line => line.startsWith('+'))
          .map(line => line.substring(1))
          .join('\n');
        
        return `File: ${file}\nChanges:\n${removedLines ? `Removed:\n${removedLines}\n` : ''}${addedLines ? `Added:\n${addedLines}` : ''}`;
      })
      .join('\n\n');

    const isDeepseek = modelConfig.name.includes('deepseek');
    const prompt = isDeepseek ? 
      `Generate 3 semantic commit messages for these changes:\n${filesInfo}\n\nRules:\n- Use one of: feat/fix/docs/style/refactor/perf/test/chore\n- Format: "type: description"\n- Be specific, no generic messages\n\nRespond with just 3 lines:\n1) type: description\n2) type: description\n3) type: description` :
      `You are a specialized code review assistant. Analyze the following code changes and generate three semantic commit messages.

Changed Files:
${filesInfo}

Instructions:
1. First, carefully analyze the code changes:
   - Look at the actual code modifications, not just file names
   - Consider the context of the changes
   - Identify patterns in the modifications
   - Determine if this is a feature, bug fix, refactor, etc.

2. Then, determine ONE of these semantic types that best matches the changes:
   - feat: New features or significant additions
   - fix: Bug fixes
   - docs: Documentation changes
   - style: Code formatting, missing semicolons, etc.
   - refactor: Code changes that neither fix bugs nor add features
   - perf: Performance improvements
   - test: Adding or modifying tests
   - chore: Build process, dependencies, or tooling changes

3. Finally, generate THREE commit messages that:
   - All use the SAME semantic type you chose
   - Follow format: type: description
   - Use present tense (e.g., "add" not "added")
   - Are concise (max 50 chars for description)
   - Start with lowercase
   - Don't end with period
   - Each highlight different aspects of the changes
   - Are specific to the code changes, not generic

IMPORTANT: Never return generic messages like "update files". Always be specific about what changed.

Format your response as:
1) type: description
2) type: description
3) type: description`;

    console.log(`Sending request to ${modelConfig.name}...`);
    
    let fullMessage: string;
    if (modelConfig.name === 'openai') {
      fullMessage = await generateWithOpenAI(prompt, modelConfig);
    } else {
      fullMessage = await generateWithOllama(prompt, modelConfig);
    }

    // Helper function to format a message
    const formatMessage = (msg: string, defaultType: string = 'chore'): string => {
      msg = msg.replace(/^\s*[-:]\s*/, '').trim();
      msg = msg.replace(/`/g, '');
      msg = msg.replace(/^.*?:\s*['"]?(feat|fix|docs|style|refactor|perf|test|chore):\s*/i, '');

      const semanticPattern = /^(feat|fix|docs|style|refactor|perf|test|chore)(\([^)]+\))?: .+$/;
      if (semanticPattern.test(msg)) {
        return msg;
      }

      const words = msg.split(/\s+/);
      const type = words[0]?.toLowerCase();
      const description = words.slice(1).join(' ');

      if (['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore'].includes(type)) {
        return `${type}: ${description}`;
      }

      const cleanDescription = description.replace(/(feat|fix|docs|style|refactor|perf|test|chore):\s*/g, '');
      return `${defaultType}: ${cleanDescription || msg}`;
    };

    let messages: string[] = fullMessage
      .split(/\d\)/)
      .map(msg => msg.trim())
      .filter(msg => msg.length > 0)
      .map(msg => formatMessage(msg));

    if (messages.length === 0) {
      messages.push("chore: update files");
    }

    const typeMatch = messages[0].match(/^([^(:]+)/);
    const firstType = typeMatch ? typeMatch[1] : 'chore';

    messages = messages
      .map(msg => {
        const content = msg.replace(/^[^:]+:\s*/, '');
        return `${firstType}: ${content}`;
      })
      .slice(0, 3);

    while (messages.length < 3) {
      messages.push(messages[0] || `${firstType}: update files`);
    }

    return { messages };
  } catch (error) {
    if (error instanceof Error) {
      console.error('Full error details:', error);
      if (error.message.includes('ECONNREFUSED')) {
        console.error('\nError: Could not connect to AI service. Please check your configuration and ensure the service is running.');
        if (error.message.includes('11434')) {
          console.error('For Ollama models:');
          console.error('1. Install Ollama from: https://ollama.ai');
          console.error('2. Open a new terminal');
          console.error('3. Run: ollama serve');
          console.error('4. Keep that terminal open and try this command again');
        }
      } else {
        console.error('\nError generating commit message:', error.message);
      }
    }
    throw error;
  }
} 