export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type': 'application/json'
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 健康检查
      if (path === '/health') {
        return new Response(JSON.stringify({
          status: 'ok',
          timestamp: new Date().toISOString(),
          version: '1.0.0',
          service: 'Private Board System API'
        }), { headers: corsHeaders });
      }

      // 调试端点
      if (path === '/debug/env' && method === 'GET') {
        return new Response(JSON.stringify({
          hasClaudeKey: !!env.CLAUDE_API_KEY,
          keyLength: env.CLAUDE_API_KEY?.length || 0,
          keyPrefix: env.CLAUDE_API_KEY?.substring(0, 20) || 'none'
        }), { headers: corsHeaders });
      }

      // 董事相关API
      if (path === '/directors/active/list' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM directors WHERE is_active = 1 ORDER BY created_at DESC'
        ).all();

        return new Response(JSON.stringify({
          success: true,
          data: results
        }), { headers: corsHeaders });
      }

      if (path === '/directors' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM directors ORDER BY created_at DESC'
        ).all();

        return new Response(JSON.stringify({
          success: true,
          data: results
        }), { headers: corsHeaders });
      }

      // 获取单个董事详情
      if (path.startsWith('/directors/') && !path.includes('/', 11) && method === 'GET') {
        const directorId = path.split('/')[2];
        
        const director = await env.DB.prepare(
          'SELECT * FROM directors WHERE id = ?'
        ).bind(directorId).first();

        if (!director) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Director not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        // 获取董事统计信息
        const { results: meetingStats } = await env.DB.prepare(`
          SELECT COUNT(*) as meeting_count
          FROM meeting_participants mp
          WHERE mp.director_id = ?
        `).bind(directorId).all();

        const { results: statementStats } = await env.DB.prepare(`
          SELECT COUNT(*) as statement_count
          FROM statements s
          WHERE s.director_id = ?
        `).bind(directorId).all();

        const directorWithStats = {
          ...director,
          total_meetings: meetingStats[0]?.meeting_count || 0,
          total_statements: statementStats[0]?.statement_count || 0,
          personality_traits: director.personality_traits ? JSON.parse(director.personality_traits) : [],
          core_beliefs: director.core_beliefs ? JSON.parse(director.core_beliefs) : [],
          expertise_areas: director.expertise_areas ? JSON.parse(director.expertise_areas) : []
        };

        return new Response(JSON.stringify({
          success: true,
          data: directorWithStats
        }), { headers: corsHeaders });
      }

      // 更新董事信息
      if (path.startsWith('/directors/') && !path.includes('/', 11) && method === 'PUT') {
        const directorId = path.split('/')[2];
        const updateData = await request.json();
        
        const director = await env.DB.prepare(
          'SELECT * FROM directors WHERE id = ?'
        ).bind(directorId).first();

        if (!director) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Director not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        await env.DB.prepare(`
          UPDATE directors 
          SET name = ?, title = ?, era = ?, system_prompt = ?, avatar_url = ?,
              personality_traits = ?, core_beliefs = ?, speaking_style = ?, 
              expertise_areas = ?, updated_at = ?
          WHERE id = ?
        `).bind(
          updateData.name || director.name,
          updateData.title || director.title,
          updateData.era || director.era,
          updateData.system_prompt || director.system_prompt,
          updateData.avatar_url || director.avatar_url,
          JSON.stringify(updateData.personality_traits || []),
          JSON.stringify(updateData.core_beliefs || []),
          updateData.speaking_style || director.speaking_style,
          JSON.stringify(updateData.expertise_areas || []),
          new Date().toISOString(),
          directorId
        ).run();

        return new Response(JSON.stringify({
          success: true,
          data: { message: 'Director updated successfully' }
        }), { headers: corsHeaders });
      }

      if (path === '/directors/create-from-prompt' && method === 'POST') {
        const { system_prompt, avatar_url } = await request.json();

        if (!system_prompt) {
          return new Response(JSON.stringify({
            success: false,
            error: 'System prompt is required'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        if (!env.CLAUDE_API_KEY) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Claude API key not configured'
          }), {
            status: 500,
            headers: corsHeaders
          });
        }

        const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1000,
            messages: [{
              role: 'user',
              content: `Based on the following character prompt, extract and generate director information in JSON format:

Character prompt: ${system_prompt}

Please return JSON in this format:
{
  "name": "Character name",
  "title": "Title or profession",
  "era": "Time period",
  "personality_traits": ["trait1", "trait2", "trait3"],
  "core_beliefs": ["belief1", "belief2", "belief3"],
  "speaking_style": "Speaking style description",
  "expertise_areas": ["area1", "area2"]
}

Return only JSON, no other text.`
            }]
          })
        });

        if (!claudeResponse.ok) {
          const errorText = await claudeResponse.text();
          return new Response(JSON.stringify({
            success: false,
            error: `Claude API failed: ${claudeResponse.status} - ${errorText}`
          }), {
            status: 500,
            headers: corsHeaders
          });
        }

        const claudeData = await claudeResponse.json();
        let parsedDirector;

        try {
          let content = claudeData.content[0].text;
          // 如果内容被包在代码块中，提取JSON部分
          if (content.includes('```json')) {
            const match = content.match(/```json\s*([\s\S]*?)\s*```/);
            if (match) {
              content = match[1];
            }
          }
          parsedDirector = JSON.parse(content);
        } catch (parseError) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Failed to parse Claude API response'
          }), {
            status: 500,
            headers: corsHeaders
          });
        }

        const id = crypto.randomUUID();
        const director = {
          id,
          name: parsedDirector.name || 'Unknown Director',
          title: parsedDirector.title || 'Historical Figure',
          era: parsedDirector.era || 'Unknown Era',
          system_prompt,
          avatar_url: avatar_url || null,
          personality_traits: JSON.stringify(parsedDirector.personality_traits || []),
          core_beliefs: JSON.stringify(parsedDirector.core_beliefs || []),
          speaking_style: parsedDirector.speaking_style || 'Unknown Style',
          expertise_areas: JSON.stringify(parsedDirector.expertise_areas || []),
          is_active: 1,
          status: 'active',
          total_statements: 0,
          total_meetings: 0,
          created_by: 'claude_ai',
          metadata: JSON.stringify({ claude_tokens: claudeData.usage?.output_tokens || 0 }),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        await env.DB.prepare(`
          INSERT INTO directors (id, name, title, era, system_prompt, avatar_url, personality_traits,
                               core_beliefs, speaking_style, expertise_areas, is_active, status,
                               total_statements, total_meetings, created_by, metadata, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          director.id, director.name, director.title, director.era, director.system_prompt,
          director.avatar_url, director.personality_traits, director.core_beliefs,
          director.speaking_style, director.expertise_areas, director.is_active,
          director.status, director.total_statements, director.total_meetings,
          director.created_by, director.metadata, director.created_at, director.updated_at
        ).run();

        return new Response(JSON.stringify({
          success: true,
          data: director
        }), { headers: corsHeaders });
      }

      // 会议相关API
      if (path === '/meetings' && method === 'POST') {
        const { title, description, topic, discussion_mode, max_rounds, max_participants, director_ids } = await request.json();

        if (!title || !topic || !director_ids || director_ids.length === 0) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Title, topic and director_ids are required'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const meetingId = crypto.randomUUID();
        const meeting = {
          id: meetingId,
          title,
          description: description || '',
          topic,
          status: 'preparing',
          max_rounds: max_rounds || 10,
          current_round: 0,
          discussion_mode: discussion_mode || 'round_robin',
          max_participants: max_participants || 8,
          total_statements: 0,
          total_participants: director_ids.length,
          created_by: 'user',
          settings: JSON.stringify({}),
          summary: '',
          key_points: JSON.stringify([]),
          controversies: JSON.stringify([]),
          metadata: JSON.stringify({}),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        // 创建会议
        await env.DB.prepare(`
          INSERT INTO meetings (id, title, description, topic, status, max_rounds, current_round,
                              discussion_mode, max_participants, total_statements, total_participants,
                              created_by, settings, summary, key_points, controversies, metadata,
                              created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          meeting.id, meeting.title, meeting.description, meeting.topic, meeting.status,
          meeting.max_rounds, meeting.current_round, meeting.discussion_mode,
          meeting.max_participants, meeting.total_statements, meeting.total_participants,
          meeting.created_by, meeting.settings, meeting.summary, meeting.key_points,
          meeting.controversies, meeting.metadata, meeting.created_at, meeting.updated_at
        ).run();

        // 添加参与者
        for (let i = 0; i < director_ids.length; i++) {
          const directorId = director_ids[i];
          const participantId = crypto.randomUUID();
          
          await env.DB.prepare(`
            INSERT INTO meeting_participants (id, meeting_id, director_id, join_order, is_active,
                                           status, statements_count, total_tokens_used, joined_at,
                                           settings, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            participantId, meetingId, directorId, i + 1, 1, 'joined', 0, 0,
            new Date().toISOString(), JSON.stringify({}),
            new Date().toISOString(), new Date().toISOString()
          ).run();
        }

        return new Response(JSON.stringify({
          success: true,
          data: meeting
        }), { headers: corsHeaders });
      }

      if (path === '/meetings' && method === 'GET') {
        const url = new URL(request.url);
        const status = url.searchParams.get('status');
        const limit = parseInt(url.searchParams.get('limit')) || 20;
        const offset = parseInt(url.searchParams.get('offset')) || 0;
        const search = url.searchParams.get('search');

        let query = 'SELECT * FROM meetings WHERE 1=1';
        let params = [];

        if (status && status !== 'all') {
          query += ' AND status = ?';
          params.push(status);
        }

        if (search) {
          query += ' AND (title LIKE ? OR topic LIKE ?)';
          params.push(`%${search}%`, `%${search}%`);
        }

        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const { results } = await env.DB.prepare(query).bind(...params).all();

        // 获取总数用于分页
        let countQuery = 'SELECT COUNT(*) as total FROM meetings WHERE 1=1';
        let countParams = [];

        if (status && status !== 'all') {
          countQuery += ' AND status = ?';
          countParams.push(status);
        }

        if (search) {
          countQuery += ' AND (title LIKE ? OR topic LIKE ?)';
          countParams.push(`%${search}%`, `%${search}%`);
        }

        const { results: countResult } = await env.DB.prepare(countQuery).bind(...countParams).all();
        const total = countResult[0]?.total || 0;

        return new Response(JSON.stringify({
          success: true,
          data: results,
          pagination: {
            total,
            limit,
            offset,
            hasMore: offset + limit < total
          }
        }), { headers: corsHeaders });
      }

      // 开始会议
      if (path.startsWith('/meetings/') && path.endsWith('/start') && method === 'POST') {
        const meetingId = path.split('/')[2];
        
        const meeting = await env.DB.prepare(
          'SELECT * FROM meetings WHERE id = ?'
        ).bind(meetingId).first();

        if (!meeting) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Meeting not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        if (meeting.status !== 'preparing') {
          return new Response(JSON.stringify({
            success: false,
            error: 'Meeting cannot be started'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // 更新会议状态为讨论中
        await env.DB.prepare(`
          UPDATE meetings 
          SET status = 'discussing', started_at = ?, current_round = 1, updated_at = ?
          WHERE id = ?
        `).bind(
          new Date().toISOString(),
          new Date().toISOString(),
          meetingId
        ).run();

        return new Response(JSON.stringify({
          success: true,
          data: { message: 'Meeting started successfully' }
        }), { headers: corsHeaders });
      }

      // 生成下一个发言
      if (path.startsWith('/meetings/') && path.endsWith('/next-statement') && method === 'POST') {
        const meetingId = path.split('/')[2];
        
        const meeting = await env.DB.prepare(
          'SELECT * FROM meetings WHERE id = ?'
        ).bind(meetingId).first();

        if (!meeting) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Meeting not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        if (!['discussing', 'debating'].includes(meeting.status)) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Meeting is not active'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // 获取会议参与者
        const { results: participants } = await env.DB.prepare(`
          SELECT mp.*, d.* 
          FROM meeting_participants mp 
          JOIN directors d ON mp.director_id = d.id 
          WHERE mp.meeting_id = ? AND mp.is_active = 1 
          ORDER BY mp.join_order
        `).bind(meetingId).all();

        if (participants.length === 0) {
          return new Response(JSON.stringify({
            success: false,
            error: 'No participants found'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // 获取已有发言
        const { results: statements } = await env.DB.prepare(`
          SELECT * FROM statements 
          WHERE meeting_id = ? 
          ORDER BY round_number DESC, sequence_in_round DESC
        `).bind(meetingId).all();

        // 根据讨论模式确定下一个发言人
        let nextDirector;
        let roundNumber = meeting.current_round;
        let sequenceInRound = 1;
        let isRebuttal = false;

        const currentRoundStatements = statements.filter(s => s.round_number === roundNumber);
        
        switch (meeting.discussion_mode) {
          case 'round_robin':
            // 轮流发言：严格按顺序
            if (statements.length === 0) {
              nextDirector = participants[0];
            } else if (currentRoundStatements.length >= participants.length) {
              roundNumber++;
              sequenceInRound = 1;
              nextDirector = participants[0];
            } else {
              sequenceInRound = currentRoundStatements.length + 1;
              const nextIndex = currentRoundStatements.length % participants.length;
              nextDirector = participants[nextIndex];
            }
            break;
            
          case 'debate':
            // 辩论模式：正反方交替，支持反驳
            if (statements.length === 0) {
              nextDirector = participants[0]; // 正方先发言
            } else {
              const lastStatement = statements[0];
              const lastDirectorIndex = participants.findIndex(p => p.director_id === lastStatement.director_id);
              const isLastProSide = lastDirectorIndex % 2 === 0;
              
              // 如果刚好是完整回合，开始新回合
              if (currentRoundStatements.length >= participants.length) {
                roundNumber++;
                sequenceInRound = 1;
                nextDirector = participants[0];
              } else {
                // 反方回应或继续辩论
                const availableOpponents = participants.filter((p, idx) => {
                  const hasSpokenThisRound = currentRoundStatements.some(s => s.director_id === p.director_id);
                  const isOpponentSide = isLastProSide ? (idx % 2 === 1) : (idx % 2 === 0);
                  return !hasSpokenThisRound && isOpponentSide;
                });
                
                if (availableOpponents.length > 0) {
                  nextDirector = availableOpponents[0];
                  isRebuttal = true;
                } else {
                  // 没有对方可以回应，选择己方未发言的
                  const availableSameSide = participants.filter((p, idx) => {
                    const hasSpokenThisRound = currentRoundStatements.some(s => s.director_id === p.director_id);
                    const isSameSide = isLastProSide ? (idx % 2 === 0) : (idx % 2 === 1);
                    return !hasSpokenThisRound && isSameSide;
                  });
                  nextDirector = availableSameSide[0] || participants[0];
                }
                sequenceInRound = currentRoundStatements.length + 1;
              }
            }
            break;
            
          case 'focus':
            // 聚焦讨论：逐层深入
            if (statements.length === 0) {
              nextDirector = participants[0];
            } else if (currentRoundStatements.length >= participants.length) {
              roundNumber++;
              sequenceInRound = 1;
              // 选择上轮发言最少的董事
              const speakerCounts = participants.map(p => ({
                ...p,
                count: statements.filter(s => s.director_id === p.director_id).length
              }));
              nextDirector = speakerCounts.sort((a, b) => a.count - b.count)[0];
            } else {
              sequenceInRound = currentRoundStatements.length + 1;
              // 选择本轮未发言的董事
              const unspokenParticipants = participants.filter(p => 
                !currentRoundStatements.some(s => s.director_id === p.director_id)
              );
              nextDirector = unspokenParticipants[0] || participants[0];
            }
            break;
            
          case 'free':
            // 自由发言：随机选择活跃度低的董事
            const speakerCounts = participants.map(p => ({
              ...p,
              recentCount: statements.slice(0, Math.min(participants.length, statements.length))
                                   .filter(s => s.director_id === p.director_id).length
            }));
            
            // 优先选择最近发言较少的董事
            const leastActiveSpeakers = speakerCounts.filter(p => 
              p.recentCount === Math.min(...speakerCounts.map(s => s.recentCount))
            );
            nextDirector = leastActiveSpeakers[Math.floor(Math.random() * leastActiveSpeakers.length)];
            
            if (currentRoundStatements.length >= participants.length * 1.5) {
              roundNumber++;
              sequenceInRound = 1;
            } else {
              sequenceInRound = currentRoundStatements.length + 1;
            }
            break;
            
          default:
            // 默认轮流模式
            nextDirector = participants[0];
        }

        // 获取用户问题
        const { results: userQuestions } = await env.DB.prepare(`
          SELECT * FROM user_questions WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 3
        `).bind(meetingId).all();

        // 构建对话上下文
        const recentStatements = statements.slice(0, 5).reverse();
        const context = recentStatements.map(s => {
          const speaker = participants.find(p => p.director_id === s.director_id);
          return `${speaker?.name || 'Unknown'}: ${s.content}`;
        }).join('\n\n');

        // 检查最近是否有用户提问需要回应
        const latestUserQuestion = userQuestions[0];
        const hasRecentQuestion = latestUserQuestion && userQuestions.length > 0;

        // 根据讨论模式生成不同的prompt
        let prompt;
        const modeInstructions = {
          'round_robin': '请按轮流发言的规则，有序地表达你的观点',
          'debate': isRebuttal ? '请针对对方刚才的观点进行有力的反驳和论证' : '请明确表达你的立场和观点，准备迎接对方的挑战',
          'focus': `请围绕核心议题进行第${roundNumber}层的深入分析`,
          'free': '请自然地参与讨论，可以灵活回应任何感兴趣的观点'
        };
        
        if (hasRecentQuestion) {
          // 如果有未回应的用户问题，重点回应
          prompt = `你是${nextDirector.name}，${nextDirector.title}。

人设背景：${nextDirector.system_prompt}

会议话题：${meeting.topic}
讨论模式：${meeting.discussion_mode} - ${modeInstructions[meeting.discussion_mode]}

刚才有用户提出了问题："${latestUserQuestion.question}"
提问者：${latestUserQuestion.asker_name}

之前的讨论背景：
${context || '（这是会议的开始）'}

请根据你的人设特点和专业领域，在${meeting.discussion_mode}模式下回应这个用户问题。回应应该：
1. 从你的历史背景和价值观出发，给出真实的观点立场
2. 如果与你的信念冲突，可以礼貌但坚定地提出不同看法
3. 体现你的专业领域和时代特色，不必迎合当代观点
4. 保持你独特的说话风格和思维方式
5. 符合当前讨论模式的特点，可以与其他董事观点相左
6. 长度控制在100-300字

重要：请基于你的真实人设立场回应，而非简单迎合用户观点。你是独立的思考者。

请直接返回回应内容，不要包含任何格式标记。`;
        } else {
          // 根据模式生成不同的讨论prompt
          let modeSpecificContext = '';
          
          switch (meeting.discussion_mode) {
            case 'debate':
              const lastStatement = statements[0];
              if (isRebuttal && lastStatement) {
                const lastDirector = participants.find(p => p.director_id === lastStatement.director_id);
                modeSpecificContext = `\n\n【需要反驳的观点】\n${lastDirector?.name}刚才说："${lastStatement.content}"\n\n请从你的价值观和专业角度，对这个观点进行有力的反驳。不要为了和谐而妥协你的立场。`;
              } else {
                modeSpecificContext = '\n\n请明确表达你的立场，准备为你的观点进行辩护。不要试图取悦所有人。';
              }
              break;
              
            case 'focus':
              modeSpecificContext = `\n\n这是第${roundNumber}层讨论。基于你的专业背景，提出可能被忽视的角度或挑战现有观点。`;
              break;
              
            case 'free':
              modeSpecificContext = '\n\n你可以自由表达，包括对之前发言的质疑或不同看法。展现你的独特视角。';
              break;
              
            default:
              modeSpecificContext = '\n\n按轮流秩序发言，但要保持你的独立观点，不必与他人观点保持一致。';
          }
          
          prompt = `你是${nextDirector.name}，${nextDirector.title}。

人设背景：${nextDirector.system_prompt}

会议话题：${meeting.topic}
讨论模式：${meeting.discussion_mode} - ${modeInstructions[meeting.discussion_mode]}

之前的讨论：
${context || '（这是会议的开始）'}${modeSpecificContext}

请根据你的人设特点，在${meeting.discussion_mode}模式下针对当前话题发表你的观点。回应应该：
1. 基于你的历史背景、价值观和专业领域形成独立立场
2. 可以与之前的讨论相关，但不必盲从他人观点
3. 保持你独特的说话风格和思维局限性
4. 如果与其他董事观点冲突，坚持你的立场
5. 符合当前讨论模式的特点，敢于表达争议观点
6. 长度控制在100-300字

重要：你是历史人物，有自己时代的局限性和固有偏见。保持真实的人设，不要为了现代政治正确而改变立场。

请直接返回发言内容，不要包含任何格式标记。`;
        }

        const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 500,
            messages: [{
              role: 'user',
              content: prompt
            }]
          })
        });

        if (!claudeResponse.ok) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Failed to generate statement'
          }), {
            status: 500,
            headers: corsHeaders
          });
        }

        const claudeData = await claudeResponse.json();
        const statementContent = claudeData.content[0].text;

        // 保存发言到数据库
        const statementId = crypto.randomUUID();
        const responseToId = (isRebuttal && statements.length > 0) ? statements[0].id : null;
        
        await env.DB.prepare(`
          INSERT INTO statements (id, meeting_id, director_id, content, round_number, 
                                sequence_in_round, response_to, tokens_used, claude_model, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          statementId, meetingId, nextDirector.director_id, statementContent,
          roundNumber, sequenceInRound, responseToId, claudeData.usage?.output_tokens || 0,
          'claude-sonnet-4-20250514', new Date().toISOString(), new Date().toISOString()
        ).run();

        // 更新会议统计
        await env.DB.prepare(`
          UPDATE meetings 
          SET total_statements = total_statements + 1, current_round = ?, updated_at = ?
          WHERE id = ?
        `).bind(roundNumber, new Date().toISOString(), meetingId).run();

        // 更新参与者统计
        await env.DB.prepare(`
          UPDATE meeting_participants 
          SET statements_count = statements_count + 1, last_statement_at = ?, updated_at = ?
          WHERE meeting_id = ? AND director_id = ?
        `).bind(
          new Date().toISOString(), new Date().toISOString(),
          meetingId, nextDirector.director_id
        ).run();

        return new Response(JSON.stringify({
          success: true,
          data: {
            id: statementId,
            content: statementContent,
            director: {
              id: nextDirector.director_id,
              name: nextDirector.name,
              title: nextDirector.title
            },
            round_number: roundNumber,
            sequence_in_round: sequenceInRound
          }
        }), { headers: corsHeaders });
      }

      // 删除董事
      if (path.startsWith('/directors/') && method === 'DELETE' && path.split('/').length === 3) {
        const directorId = path.split('/')[2];
        
        const director = await env.DB.prepare(
          'SELECT * FROM directors WHERE id = ?'
        ).bind(directorId).first();

        if (!director) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Director not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        // 先删除相关的外键引用记录
        await env.DB.prepare('DELETE FROM statements WHERE director_id = ?').bind(directorId).run();
        await env.DB.prepare('DELETE FROM meeting_participants WHERE director_id = ?').bind(directorId).run();
        
        // 删除董事
        await env.DB.prepare('DELETE FROM directors WHERE id = ?').bind(directorId).run();

        return new Response(JSON.stringify({
          success: true,
          data: { message: 'Director deleted successfully' }
        }), { headers: corsHeaders });
      }

      // 批量更新董事状态
      if (path === '/directors/batch-status' && method === 'PATCH') {
        const { director_ids, status, is_active } = await request.json();

        if (!director_ids || !Array.isArray(director_ids)) {
          return new Response(JSON.stringify({
            success: false,
            error: 'director_ids array is required'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        let updateCount = 0;
        for (const directorId of director_ids) {
          const result = await env.DB.prepare(`
            UPDATE directors 
            SET status = ?, is_active = ?, updated_at = ?
            WHERE id = ?
          `).bind(
            status || 'active',
            is_active !== undefined ? (is_active ? 1 : 0) : 1,
            new Date().toISOString(),
            directorId
          ).run();
          
          if (result.success) updateCount++;
        }

        return new Response(JSON.stringify({
          success: true,
          data: { updated_count: updateCount }
        }), { headers: corsHeaders });
      }

      // 用户提问相关API
      if (path.startsWith('/meetings/') && path.endsWith('/questions') && method === 'POST') {
        const meetingId = path.split('/')[2];
        const { question, asker_name, question_type } = await request.json();

        if (!question) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Question is required'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const meeting = await env.DB.prepare(
          'SELECT * FROM meetings WHERE id = ?'
        ).bind(meetingId).first();

        if (!meeting) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Meeting not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        // 保存用户问题
        const questionId = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO user_questions (id, meeting_id, question, asker_name, question_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          questionId, meetingId, question, asker_name || '用户',
          question_type || 'general', new Date().toISOString(), new Date().toISOString()
        ).run();

        return new Response(JSON.stringify({
          success: true,
          data: { 
            id: questionId, 
            question, 
            asker_name: asker_name || '用户',
            status: 'pending' 
          }
        }), { headers: corsHeaders });
      }

      if (path.startsWith('/meetings/') && path.endsWith('/questions') && method === 'GET') {
        const meetingId = path.split('/')[2];
        
        const { results: questions } = await env.DB.prepare(`
          SELECT q.*, 
                 COUNT(r.id) as response_count
          FROM user_questions q
          LEFT JOIN question_responses r ON q.id = r.question_id
          WHERE q.meeting_id = ?
          GROUP BY q.id
          ORDER BY q.created_at DESC
        `).bind(meetingId).all();

        // 获取每个问题的完整回应信息
        for (let question of questions) {
          const { results: responses } = await env.DB.prepare(`
            SELECT r.*, d.name as director_name, d.title as director_title, d.avatar_url as director_avatar
            FROM question_responses r
            JOIN directors d ON r.director_id = d.id
            WHERE r.question_id = ?
            ORDER BY r.response_order
          `).bind(question.id).all();
          
          question.responses = responses.map(r => ({
            id: r.id,
            content: r.content,
            director: {
              name: r.director_name,
              title: r.director_title,
              avatar_url: r.director_avatar
            },
            created_at: r.created_at
          }));
          
          question.status = responses.length > 0 ? 'answered' : 'pending';
        }

        return new Response(JSON.stringify({
          success: true,
          data: questions
        }), { headers: corsHeaders });
      }

      if (path.startsWith('/meetings/') && path.includes('/questions/') && path.endsWith('/respond') && method === 'POST') {
        const pathParts = path.split('/');
        const meetingId = pathParts[2];
        const questionId = pathParts[4];

        const question = await env.DB.prepare(
          'SELECT * FROM user_questions WHERE id = ? AND meeting_id = ?'
        ).bind(questionId, meetingId).first();

        if (!question) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Question not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        // 获取会议参与的董事
        const { results: participants } = await env.DB.prepare(`
          SELECT mp.*, d.* 
          FROM meeting_participants mp 
          JOIN directors d ON mp.director_id = d.id 
          WHERE mp.meeting_id = ? AND mp.is_active = 1 
          ORDER BY mp.join_order
        `).bind(meetingId).all();

        if (participants.length === 0) {
          return new Response(JSON.stringify({
            success: false,
            error: 'No participants found'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // 为每个董事生成回应
        const responses = [];
        for (let i = 0; i < participants.length; i++) {
          const director = participants[i];
          
          const prompt = `你是${director.name}，${director.title}。

人设背景：${director.system_prompt}

有用户在会议中提出了问题："${question.question}"

请根据你的人设特点和专业领域，简洁地回应这个问题。回应应该：
1. 基于你的历史背景和核心价值观给出真实立场
2. 如果问题与你的信念或时代背景冲突，可以表达不同观点
3. 保持你独特的说话风格和思维方式
4. 不必迎合用户期望，坚持你的人设特色
5. 长度控制在50-150字

重要：你是独立的历史人物，有自己的立场和局限性。

请直接返回回应内容，不要包含任何格式标记。`;

          const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': env.CLAUDE_API_KEY,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 300,
              messages: [{
                role: 'user',
                content: prompt
              }]
            })
          });

          if (claudeResponse.ok) {
            const claudeData = await claudeResponse.json();
            const responseContent = claudeData.content[0].text;

            const responseId = crypto.randomUUID();
            await env.DB.prepare(`
              INSERT INTO question_responses (id, question_id, director_id, content, response_order, tokens_used, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              responseId, questionId, director.director_id, responseContent, i + 1,
              claudeData.usage?.output_tokens || 0, new Date().toISOString(), new Date().toISOString()
            ).run();

            responses.push({
              id: responseId,
              director: {
                name: director.name,
                title: director.title,
                avatar_url: director.avatar_url
              },
              content: responseContent,
              response_order: i + 1
            });
          }
        }

        // 更新问题状态
        await env.DB.prepare(`
          UPDATE user_questions SET status = 'answered', updated_at = ? WHERE id = ?
        `).bind(new Date().toISOString(), questionId).run();

        return new Response(JSON.stringify({
          success: true,
          data: {
            question_id: questionId,
            responses: responses
          }
        }), { headers: corsHeaders });
      }

      // 收藏相关API
      if (path === '/favorites' && method === 'POST') {
        const { statement_id, response_id, favorite_type, tags, notes, user_id } = await request.json();

        if (!statement_id && !response_id) {
          return new Response(JSON.stringify({
            success: false,
            error: 'statement_id or response_id is required'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        if (!favorite_type) {
          return new Response(JSON.stringify({
            success: false,
            error: 'favorite_type is required'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // 检查是否已收藏
        const existing = await env.DB.prepare(`
          SELECT id FROM user_favorites 
          WHERE user_id = ? AND 
                (statement_id = ? OR response_id = ?)
        `).bind(
          user_id || 'default_user',
          statement_id || null,
          response_id || null
        ).first();

        if (existing) {
          return new Response(JSON.stringify({
            success: false,
            error: '已经收藏过这条内容'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const favoriteId = crypto.randomUUID();
        await env.DB.prepare(`
          INSERT INTO user_favorites (id, user_id, statement_id, response_id, favorite_type, tags, notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          favoriteId, user_id || 'default_user', statement_id || null, response_id || null,
          favorite_type, JSON.stringify(tags || []), notes || '', new Date().toISOString()
        ).run();

        return new Response(JSON.stringify({
          success: true,
          data: { id: favoriteId, message: '收藏成功' }
        }), { headers: corsHeaders });
      }

      if (path === '/favorites' && method === 'GET') {
        const url = new URL(request.url);
        const userId = url.searchParams.get('user_id') || 'default_user';
        const favoriteType = url.searchParams.get('type');

        let query = `
          SELECT f.*, 
                 s.content as statement_content, s.created_at as statement_created_at,
                 d.name as director_name, d.title as director_title, d.avatar_url as director_avatar,
                 m.title as meeting_title, m.topic as meeting_topic,
                 r.content as response_content, r.created_at as response_created_at
          FROM user_favorites f
          LEFT JOIN statements s ON f.statement_id = s.id
          LEFT JOIN question_responses r ON f.response_id = r.id
          LEFT JOIN directors d ON (s.director_id = d.id OR r.director_id = d.id)
          LEFT JOIN meetings m ON s.meeting_id = m.id
          WHERE f.user_id = ?
        `;
        const params = [userId];

        if (favoriteType) {
          query += ' AND f.favorite_type = ?';
          params.push(favoriteType);
        }

        query += ' ORDER BY f.created_at DESC';

        const { results } = await env.DB.prepare(query).bind(...params).all();

        return new Response(JSON.stringify({
          success: true,
          data: results.map(fav => ({
            ...fav,
            content: fav.statement_content || fav.response_content,
            content_created_at: fav.statement_created_at || fav.response_created_at,
            director: {
              name: fav.director_name,
              title: fav.director_title,
              avatar_url: fav.director_avatar
            },
            meeting: {
              title: fav.meeting_title,
              topic: fav.meeting_topic
            },
            tags: fav.tags ? JSON.parse(fav.tags) : []
          }))
        }), { headers: corsHeaders });
      }

      if (path.startsWith('/favorites/') && method === 'DELETE') {
        const favoriteId = path.split('/')[2];
        const url = new URL(request.url);
        const userId = url.searchParams.get('user_id') || 'default_user';

        const favorite = await env.DB.prepare(
          'SELECT * FROM user_favorites WHERE id = ? AND user_id = ?'
        ).bind(favoriteId, userId).first();

        if (!favorite) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Favorite not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        await env.DB.prepare('DELETE FROM user_favorites WHERE id = ?').bind(favoriteId).run();

        return new Response(JSON.stringify({
          success: true,
          data: { message: '取消收藏成功' }
        }), { headers: corsHeaders });
      }

      if (path === '/favorites/tags' && method === 'GET') {
        const url = new URL(request.url);
        const userId = url.searchParams.get('user_id') || 'default_user';

        const { results } = await env.DB.prepare(`
          SELECT DISTINCT tags FROM user_favorites WHERE user_id = ? AND tags != '[]'
        `).bind(userId).all();

        const allTags = new Set();
        results.forEach(row => {
          try {
            const tags = JSON.parse(row.tags);
            tags.forEach(tag => allTags.add(tag));
          } catch (e) {}
        });

        return new Response(JSON.stringify({
          success: true,
          data: Array.from(allTags).sort()
        }), { headers: corsHeaders });
      }

      // 董事组合相关API
      if (path === '/director-groups' && method === 'POST') {
        const { name, description, director_ids, user_id } = await request.json();

        if (!name || !director_ids || director_ids.length === 0) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Name and director_ids are required'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const groupId = crypto.randomUUID();
        
        // 创建董事组合
        await env.DB.prepare(`
          INSERT INTO director_groups (id, name, description, user_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          groupId, name, description || '', user_id || 'default_user',
          new Date().toISOString(), new Date().toISOString()
        ).run();

        // 添加组合成员
        for (let i = 0; i < director_ids.length; i++) {
          const memberId = crypto.randomUUID();
          await env.DB.prepare(`
            INSERT INTO group_members (id, group_id, director_id, member_order, added_at)
            VALUES (?, ?, ?, ?, ?)
          `).bind(
            memberId, groupId, director_ids[i], i + 1, new Date().toISOString()
          ).run();
        }

        return new Response(JSON.stringify({
          success: true,
          data: { id: groupId, name, description, member_count: director_ids.length }
        }), { headers: corsHeaders });
      }

      if (path === '/director-groups' && method === 'GET') {
        const url = new URL(request.url);
        const userId = url.searchParams.get('user_id') || 'default_user';

        const { results: groups } = await env.DB.prepare(`
          SELECT dg.*, COUNT(gm.id) as member_count
          FROM director_groups dg
          LEFT JOIN group_members gm ON dg.id = gm.group_id
          WHERE dg.user_id = ?
          GROUP BY dg.id
          ORDER BY dg.created_at DESC
        `).bind(userId).all();

        return new Response(JSON.stringify({
          success: true,
          data: groups
        }), { headers: corsHeaders });
      }

      if (path.startsWith('/director-groups/') && !path.includes('/', 18) && method === 'GET') {
        const groupId = path.split('/')[2];
        
        const group = await env.DB.prepare(
          'SELECT * FROM director_groups WHERE id = ?'
        ).bind(groupId).first();

        if (!group) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Group not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        // 获取组合成员
        const { results: members } = await env.DB.prepare(`
          SELECT gm.*, d.name, d.title, d.avatar_url, d.era, d.expertise_areas
          FROM group_members gm
          JOIN directors d ON gm.director_id = d.id
          WHERE gm.group_id = ?
          ORDER BY gm.member_order
        `).bind(groupId).all();

        return new Response(JSON.stringify({
          success: true,
          data: {
            ...group,
            members: members.map(m => ({
              ...m,
              director: {
                id: m.director_id,
                name: m.name,
                title: m.title,
                avatar_url: m.avatar_url,
                era: m.era,
                expertise_areas: m.expertise_areas
              }
            }))
          }
        }), { headers: corsHeaders });
      }

      if (path.startsWith('/director-groups/') && method === 'DELETE') {
        const groupId = path.split('/')[2];
        const url = new URL(request.url);
        const userId = url.searchParams.get('user_id') || 'default_user';

        const group = await env.DB.prepare(
          'SELECT * FROM director_groups WHERE id = ? AND user_id = ?'
        ).bind(groupId, userId).first();

        if (!group) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Group not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        // 删除组合成员
        await env.DB.prepare('DELETE FROM group_members WHERE group_id = ?').bind(groupId).run();
        
        // 删除组合
        await env.DB.prepare('DELETE FROM director_groups WHERE id = ?').bind(groupId).run();

        return new Response(JSON.stringify({
          success: true,
          data: { message: 'Director group deleted successfully' }
        }), { headers: corsHeaders });
      }

      if (path.startsWith('/meetings/from-group/') && method === 'POST') {
        const groupId = path.split('/')[3];
        const { title, description, topic, discussion_mode, max_rounds } = await request.json();

        if (!title || !topic) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Title and topic are required'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // 获取组合成员
        const { results: members } = await env.DB.prepare(`
          SELECT director_id FROM group_members WHERE group_id = ? ORDER BY member_order
        `).bind(groupId).all();

        if (members.length === 0) {
          return new Response(JSON.stringify({
            success: false,
            error: 'No directors in group'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const director_ids = members.map(m => m.director_id);

        // 创建会议（复用现有逻辑）
        const meetingId = crypto.randomUUID();
        const meeting = {
          id: meetingId,
          title,
          description: description || '',
          topic,
          status: 'preparing',
          max_rounds: max_rounds || 10,
          current_round: 0,
          discussion_mode: discussion_mode || 'round_robin',
          max_participants: director_ids.length,
          total_statements: 0,
          total_participants: director_ids.length,
          created_by: 'user',
          settings: JSON.stringify({}),
          summary: '',
          key_points: JSON.stringify([]),
          controversies: JSON.stringify([]),
          metadata: JSON.stringify({ created_from_group: groupId }),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        await env.DB.prepare(`
          INSERT INTO meetings (id, title, description, topic, status, max_rounds, current_round,
                              discussion_mode, max_participants, total_statements, total_participants,
                              created_by, settings, summary, key_points, controversies, metadata,
                              created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          meeting.id, meeting.title, meeting.description, meeting.topic, meeting.status,
          meeting.max_rounds, meeting.current_round, meeting.discussion_mode,
          meeting.max_participants, meeting.total_statements, meeting.total_participants,
          meeting.created_by, meeting.settings, meeting.summary, meeting.key_points,
          meeting.controversies, meeting.metadata, meeting.created_at, meeting.updated_at
        ).run();

        // 添加参与者
        for (let i = 0; i < director_ids.length; i++) {
          const directorId = director_ids[i];
          const participantId = crypto.randomUUID();
          
          await env.DB.prepare(`
            INSERT INTO meeting_participants (id, meeting_id, director_id, join_order, is_active,
                                           status, statements_count, total_tokens_used, joined_at,
                                           settings, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            participantId, meetingId, directorId, i + 1, 1, 'joined', 0, 0,
            new Date().toISOString(), JSON.stringify({}),
            new Date().toISOString(), new Date().toISOString()
          ).run();
        }

        // 更新组合使用次数
        await env.DB.prepare(`
          UPDATE director_groups SET usage_count = usage_count + 1, updated_at = ? WHERE id = ?
        `).bind(new Date().toISOString(), groupId).run();

        return new Response(JSON.stringify({
          success: true,
          data: meeting
        }), { headers: corsHeaders });
      }

      // 金句卡片生成API
      if (path.startsWith('/statements/') && path.endsWith('/card') && method === 'GET') {
        const statementId = path.split('/')[2];
        
        const statement = await env.DB.prepare(`
          SELECT s.*, d.name as director_name, d.title as director_title, 
                 d.avatar_url as director_avatar, d.era as director_era,
                 m.title as meeting_title, m.topic as meeting_topic
          FROM statements s
          JOIN directors d ON s.director_id = d.id
          JOIN meetings m ON s.meeting_id = m.id
          WHERE s.id = ?
        `).bind(statementId).first();

        if (!statement) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Statement not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        // 使用Claude API提取关键词和情感分析
        if (env.CLAUDE_API_KEY) {
          try {
            const analysisPrompt = `请分析以下发言内容，提取关键信息：

发言内容："${statement.content}"
发言人：${statement.director_name}（${statement.director_title}）

请返回JSON格式的分析结果：
{
  "keywords": ["关键词1", "关键词2", "关键词3"],
  "sentiment": "positive|neutral|negative",
  "highlight_quote": "最精彩的一句话（30字以内）",
  "theme_color": "#颜色代码（根据情感和内容推荐）",
  "category": "智慧|争议|深度|启发|经典"
}

只返回JSON，不要其他内容。`;

            const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': env.CLAUDE_API_KEY,
                'anthropic-version': '2023-06-01'
              },
              body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 300,
                messages: [{
                  role: 'user',
                  content: analysisPrompt
                }]
              })
            });

            if (claudeResponse.ok) {
              const claudeData = await claudeResponse.json();
              let analysisResult = {};
              
              try {
                let content = claudeData.content[0].text;
                if (content.includes('```json')) {
                  const match = content.match(/```json\s*([\s\S]*?)\s*```/);
                  if (match) {
                    content = match[1];
                  }
                }
                analysisResult = JSON.parse(content);
              } catch (e) {
                analysisResult = {
                  keywords: [],
                  sentiment: 'neutral',
                  highlight_quote: statement.content.substring(0, 30),
                  theme_color: '#1976d2',
                  category: '经典'
                };
              }

              return new Response(JSON.stringify({
                success: true,
                data: {
                  id: statement.id,
                  content: statement.content,
                  director: {
                    name: statement.director_name,
                    title: statement.director_title,
                    avatar_url: statement.director_avatar,
                    era: statement.director_era
                  },
                  meeting: {
                    title: statement.meeting_title,
                    topic: statement.meeting_topic
                  },
                  analysis: analysisResult,
                  created_at: statement.created_at,
                  round_number: statement.round_number
                }
              }), { headers: corsHeaders });
            }
          } catch (error) {
            console.error('Claude analysis failed:', error);
          }
        }

        // 如果Claude API不可用，返回基础数据
        return new Response(JSON.stringify({
          success: true,
          data: {
            id: statement.id,
            content: statement.content,
            director: {
              name: statement.director_name,
              title: statement.director_title,
              avatar_url: statement.director_avatar,
              era: statement.director_era
            },
            meeting: {
              title: statement.meeting_title,
              topic: statement.meeting_topic
            },
            analysis: {
              keywords: [],
              sentiment: 'neutral',
              highlight_quote: statement.content.substring(0, 30),
              theme_color: '#1976d2',
              category: '经典'
            },
            created_at: statement.created_at,
            round_number: statement.round_number
          }
        }), { headers: corsHeaders });
      }

      // 会议摘要生成API
      if (path.startsWith('/meetings/') && path.endsWith('/summary') && method === 'POST') {
        const meetingId = path.split('/')[2];
        
        const meeting = await env.DB.prepare(
          'SELECT * FROM meetings WHERE id = ?'
        ).bind(meetingId).first();

        if (!meeting) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Meeting not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        // 获取所有发言记录和用户问题，按时间顺序合并
        const { results: discussionData } = await env.DB.prepare(`
          SELECT content, created_at, 'statement' as type, d.name as speaker_name, d.title as speaker_title
          FROM statements s 
          JOIN directors d ON s.director_id = d.id 
          WHERE s.meeting_id = ?
          UNION ALL
          SELECT question as content, created_at, 'user_question' as type, asker_name as speaker_name, NULL as speaker_title
          FROM user_questions 
          WHERE meeting_id = ?
          ORDER BY created_at
        `).bind(meetingId, meetingId).all();

        if (discussionData.length === 0) {
          return new Response(JSON.stringify({
            success: false,
            error: 'No discussion content found in meeting'
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // 构建完整讨论内容（包含董事发言和用户问题）
        const discussionContent = discussionData.map((item, index) => {
          if (item.type === 'statement') {
            return `${index + 1}. ${item.speaker_name}（${item.speaker_title}）：\n${item.content}`;
          } else {
            return `${index + 1}. 用户提问（${item.speaker_name}）：\n${item.content}`;
          }
        }).join('\n\n');

        // 获取参与董事列表用于摘要
        const { results: participantDirectors } = await env.DB.prepare(`
          SELECT DISTINCT d.name, d.title
          FROM statements s 
          JOIN directors d ON s.director_id = d.id 
          WHERE s.meeting_id = ?
        `).bind(meetingId).all();

        if (!env.CLAUDE_API_KEY) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Claude API key not configured'
          }), {
            status: 500,
            headers: corsHeaders
          });
        }

        // 使用Claude API生成摘要
        const summaryPrompt = `请为以下董事会会议生成专业摘要：

会议标题：${meeting.title}
讨论话题：${meeting.topic}
参与董事：${participantDirectors.map(d => d.name).join('、')}
总讨论数：${discussionData.length}条（包含董事发言和用户问题）

完整讨论内容：
${discussionContent}

请生成JSON格式的会议摘要：
{
  "executive_summary": "会议核心要点总结（150字以内）",
  "key_points": ["要点1", "要点2", "要点3"],
  "agreements": ["达成的共识点"],
  "disagreements": ["争议分歧点"],
  "insights": ["深度洞察和启发"],
  "participant_highlights": [
    {
      "director": "董事姓名",
      "key_contribution": "主要贡献观点"
    }
  ],
  "next_steps": ["后续可探讨的方向"],
  "rating": {
    "depth": 8,
    "controversy": 6,
    "insight": 9
  }
}

只返回JSON，不要其他内容。`;

        try {
          const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': env.CLAUDE_API_KEY,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 1500,
              messages: [{
                role: 'user',
                content: summaryPrompt
              }]
            })
          });

          if (!claudeResponse.ok) {
            throw new Error(`Claude API failed: ${claudeResponse.status}`);
          }

          const claudeData = await claudeResponse.json();
          let summaryResult = {};
          
          try {
            let content = claudeData.content[0].text;
            if (content.includes('```json')) {
              const match = content.match(/```json\s*([\s\S]*?)\s*```/);
              if (match) {
                content = match[1];
              }
            }
            summaryResult = JSON.parse(content);
          } catch (e) {
            summaryResult = {
              executive_summary: '会议讨论了' + meeting.topic + '，各位董事发表了深度见解。',
              key_points: ['讨论话题：' + meeting.topic],
              agreements: [],
              disagreements: [],
              insights: [],
              participant_highlights: [],
              next_steps: [],
              rating: { depth: 7, controversy: 5, insight: 7 }
            };
          }

          // 更新会议摘要到数据库
          await env.DB.prepare(`
            UPDATE meetings 
            SET summary = ?, key_points = ?, controversies = ?, metadata = ?, updated_at = ?
            WHERE id = ?
          `).bind(
            summaryResult.executive_summary,
            JSON.stringify(summaryResult.key_points),
            JSON.stringify(summaryResult.disagreements),
            JSON.stringify({ 
              summary_generated: true,
              ai_analysis: summaryResult,
              tokens_used: claudeData.usage?.output_tokens || 0
            }),
            new Date().toISOString(),
            meetingId
          ).run();

          return new Response(JSON.stringify({
            success: true,
            data: {
              meeting_id: meetingId,
              summary: summaryResult,
              generated_at: new Date().toISOString()
            }
          }), { headers: corsHeaders });

        } catch (error) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Failed to generate summary: ' + error.message
          }), {
            status: 500,
            headers: corsHeaders
          });
        }
      }

      // 会议全文导出API
      if (path.startsWith('/meetings/') && path.endsWith('/export') && method === 'POST') {
        const meetingId = path.split('/')[2];
        const { export_type, include_analysis } = await request.json();

        const meeting = await env.DB.prepare(
          'SELECT * FROM meetings WHERE id = ?'
        ).bind(meetingId).first();

        if (!meeting) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Meeting not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        // 获取详细的会议数据，包括用户提问（按时间顺序整合）
        const { results: allStatements } = await env.DB.prepare(`
          SELECT 
            s.*, 
            d.name as director_name, 
            d.title as director_title, 
            d.era as director_era,
            'statement' as record_type
          FROM statements s
          JOIN directors d ON s.director_id = d.id
          WHERE s.meeting_id = ?
          
          UNION ALL
          
          SELECT
            id,
            meeting_id,
            NULL as director_id,
            question as content,
            NULL as content_type,
            NULL as round_number,
            NULL as sequence_in_round,
            NULL as response_to,
            NULL as tokens_used,
            NULL as generation_time,
            NULL as claude_model,
            NULL as emotion_level,
            NULL as controversy_score,
            NULL as topic_relevance,
            NULL as keywords,
            NULL as mentioned_directors,
            NULL as sentiment,
            NULL as metadata,
            NULL as is_appropriate,
            NULL as flagged_reason,
            created_at,
            updated_at,
            asker_name as director_name,
            '用户' as director_title,
            '现代' as director_era,
            'user_question' as record_type
          FROM user_questions
          WHERE meeting_id = ?
          
          ORDER BY created_at
        `).bind(meetingId, meetingId).all();

        const { results: participants } = await env.DB.prepare(`
          SELECT mp.*, d.name, d.title, d.era, d.expertise_areas
          FROM meeting_participants mp
          JOIN directors d ON mp.director_id = d.id
          WHERE mp.meeting_id = ?
          ORDER BY mp.join_order
        `).bind(meetingId).all();

        // 分离发言和问题，但保持时间顺序
        const statements = allStatements.filter(s => s.record_type === 'statement');
        const questions = allStatements.filter(s => s.record_type === 'user_question');

        // 生成不同格式的导出内容
        let exportContent = '';
        let shareId = crypto.randomUUID();

        if (export_type === 'markdown') {
          exportContent = `# ${meeting.title}

**会议信息**
- 讨论话题：${meeting.topic}
- 讨论模式：${meeting.discussion_mode === 'round_robin' ? '轮流发言' : meeting.discussion_mode === 'debate' ? '辩论模式' : meeting.discussion_mode === 'focus' ? '聚焦讨论' : meeting.discussion_mode === 'free' ? '自由发言' : '未知'}
- 开始时间：${meeting.started_at || '未开始'}
- 状态：${meeting.status}
- ${meeting.discussion_mode === 'debate' ? '回合' : meeting.discussion_mode === 'focus' ? '层数' : '轮数'}：${meeting.current_round}/${meeting.max_rounds}
- 总记录：${allStatements.length}条

## 参与董事

${participants.map(p => `- **${p.name}**（${p.title}，${p.era}）`).join('\n')}

## 会议完整记录

${allStatements.map((record, index) => {
  // 检查是否需要显示轮次分隔符
  const isStatement = record.record_type === 'statement';
  const roundMark = isStatement && (index === 0 || 
    (allStatements[index - 1]?.round_number !== record.round_number && allStatements[index - 1]?.record_type === 'statement'))
    ? `\n### 第${record.round_number}${meeting.discussion_mode === 'debate' ? '回合' : meeting.discussion_mode === 'focus' ? '层讨论' : '轮'}\n\n` : '';
  
  if (record.record_type === 'user_question') {
    return `${roundMark}**[用户提问]** ${record.director_name}：\n\n> ${record.content}\n\n---\n`;
  } else {
    const rebuttalMark = meeting.discussion_mode === 'debate' && record.response_to ? '\n*（反驳上一位发言）*\n\n' : '';
    return `${roundMark}**${record.director_name}**${meeting.discussion_mode === 'debate' ? (record.sequence_in_round % 2 === 1 ? '（正方）' : '（反方）') : ''}：${rebuttalMark}\n\n${record.content}\n\n---\n`;
  }
}).join('')}

---
*由私人董事会系统自动生成*`;

        } else if (export_type === 'text') {
          exportContent = `${meeting.title}

会议信息：
讨论话题：${meeting.topic}
讨论模式：${meeting.discussion_mode === 'round_robin' ? '轮流发言' : meeting.discussion_mode === 'debate' ? '辩论模式' : meeting.discussion_mode === 'focus' ? '聚焦讨论' : meeting.discussion_mode === 'free' ? '自由发言' : '未知'}
开始时间：${meeting.started_at || '未开始'}
参与董事：${participants.map(p => p.name).join('、')}
总记录数：${allStatements.length}条

════════════════════════════════════════

会议完整记录：

${allStatements.map((record, index) => {
  // 检查是否需要显示轮次分隔符
  const isStatement = record.record_type === 'statement';
  const roundMark = isStatement && (index === 0 || 
    (allStatements[index - 1]?.round_number !== record.round_number && allStatements[index - 1]?.record_type === 'statement'))
    ? `\n【第${record.round_number}${meeting.discussion_mode === 'debate' ? '回合' : meeting.discussion_mode === 'focus' ? '层讨论' : '轮'}】\n` : '';
  
  if (record.record_type === 'user_question') {
    return `${roundMark}[用户提问] ${record.director_name}：\n${record.content}\n`;
  } else {
    const sideInfo = meeting.discussion_mode === 'debate' ? 
      `（${record.sequence_in_round % 2 === 1 ? '正方' : '反方'}）` : '';
    const rebuttalMark = meeting.discussion_mode === 'debate' && record.response_to ? '（反驳上一位发言）' : '';
    return `${roundMark}${record.director_name}${sideInfo}${rebuttalMark}：\n${record.content}\n`;
  }
}).join('\n')}

════════════════════════════════════════
由私人董事会系统生成`;
        }

        // 保存分享记录
        await env.DB.prepare(`
          INSERT INTO meeting_shares (id, meeting_id, share_type, title, content, summary, 
                                    highlight_statements, view_count, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          shareId, meetingId, export_type || 'text', meeting.title, exportContent,
          meeting.summary || '', JSON.stringify([]), 0,
          new Date().toISOString(), new Date().toISOString()
        ).run();

        return new Response(JSON.stringify({
          success: true,
          data: {
            share_id: shareId,
            export_type: export_type || 'text',
            content: exportContent,
            meeting_info: {
              title: meeting.title,
              topic: meeting.topic,
              discussion_mode: meeting.discussion_mode,
              statement_count: statements.length,
              participant_count: participants.length,
              question_count: questions.length,
              total_records: allStatements.length
            },
            generated_at: new Date().toISOString()
          }
        }), { headers: corsHeaders });
      }

      // 删除会议
      if (path.startsWith('/meetings/') && !path.includes('/', 10) && method === 'DELETE') {
        const meetingId = path.split('/')[2];
        
        const meeting = await env.DB.prepare(
          'SELECT * FROM meetings WHERE id = ?'
        ).bind(meetingId).first();

        if (!meeting) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Meeting not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        try {
          // 删除相关的所有记录（按照外键依赖顺序）
          await env.DB.prepare('DELETE FROM question_responses WHERE question_id IN (SELECT id FROM user_questions WHERE meeting_id = ?)').bind(meetingId).run();
          await env.DB.prepare('DELETE FROM user_questions WHERE meeting_id = ?').bind(meetingId).run();
          await env.DB.prepare('DELETE FROM user_favorites WHERE statement_id IN (SELECT id FROM statements WHERE meeting_id = ?)').bind(meetingId).run();
          await env.DB.prepare('DELETE FROM statements WHERE meeting_id = ?').bind(meetingId).run();
          await env.DB.prepare('DELETE FROM meeting_participants WHERE meeting_id = ?').bind(meetingId).run();
          await env.DB.prepare('DELETE FROM meeting_shares WHERE meeting_id = ?').bind(meetingId).run();
          await env.DB.prepare('DELETE FROM meetings WHERE id = ?').bind(meetingId).run();

          return new Response(JSON.stringify({
            success: true,
            data: { message: 'Meeting deleted successfully' }
          }), { headers: corsHeaders });
        } catch (error) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Failed to delete meeting: ' + error.message
          }), {
            status: 500,
            headers: corsHeaders
          });
        }
      }

      // 获取会议详情（包含参与者和发言）
      if (path.startsWith('/meetings/') && !path.includes('/', 10) && method === 'GET') {
        const meetingId = path.split('/')[2];
        
        const meeting = await env.DB.prepare(
          'SELECT * FROM meetings WHERE id = ?'
        ).bind(meetingId).first();

        if (!meeting) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Meeting not found'
          }), {
            status: 404,
            headers: corsHeaders
          });
        }

        // 获取参与者信息
        const { results: participants } = await env.DB.prepare(`
          SELECT mp.*, d.name, d.title, d.avatar_url, d.era
          FROM meeting_participants mp
          JOIN directors d ON mp.director_id = d.id
          WHERE mp.meeting_id = ?
          ORDER BY mp.join_order
        `).bind(meetingId).all();

        // 获取发言记录
        const { results: statements } = await env.DB.prepare(`
          SELECT s.*, d.name as director_name, d.title as director_title, d.avatar_url as director_avatar
          FROM statements s
          JOIN directors d ON s.director_id = d.id
          WHERE s.meeting_id = ?
          ORDER BY s.round_number, s.sequence_in_round
        `).bind(meetingId).all();

        // 获取用户问题，也作为"发言"显示
        const { results: userQuestions } = await env.DB.prepare(`
          SELECT q.*, q.asker_name as director_name, '用户提问' as director_title, 
                 null as director_avatar, q.created_at, 
                 COALESCE((SELECT MAX(round_number) FROM statements WHERE meeting_id = ?), meeting.current_round) as round_number,
                 999 as sequence_in_round,
                 'user_question' as content_type,
                 '【用户提问 - ' || q.asker_name || '】: ' || q.question as content
          FROM user_questions q, meetings meeting
          WHERE q.meeting_id = ? AND meeting.id = ?
          ORDER BY q.created_at
        `).bind(meetingId, meetingId, meetingId).all();

        // 合并statements和用户问题，按时间排序
        const allStatements = [...statements, ...userQuestions].sort((a, b) => {
          return new Date(a.created_at) - new Date(b.created_at);
        });

        // 为每个发言添加Director对象
        const statementsWithDirector = allStatements.map(statement => ({
          ...statement,
          Director: {
            name: statement.director_name,
            title: statement.director_title,
            avatar_url: statement.director_avatar
          }
        }));

        return new Response(JSON.stringify({
          success: true,
          data: {
            ...meeting,
            participants: participants.map(p => ({
              ...p,
              director: {
                name: p.name,
                title: p.title,
                avatar_url: p.avatar_url,
                era: p.era
              },
              statement_count: p.statements_count
            })),
            statements: statementsWithDirector
          }
        }), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({
        success: false,
        error: 'API endpoint not found',
        path: path,
        method: method
      }), {
        status: 404,
        headers: corsHeaders
      });

    } catch (err) {
      return new Response(JSON.stringify({
        success: false,
        error: err.message
      }), {
        status: 500,
        headers: corsHeaders
      });
    }
  }
};