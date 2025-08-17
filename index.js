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
        const { results } = await env.DB.prepare(
          'SELECT * FROM meetings ORDER BY created_at DESC LIMIT 50'
        ).all();

        return new Response(JSON.stringify({
          success: true,
          data: results
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

        // 确定下一个发言人
        let nextDirector;
        let roundNumber = meeting.current_round;
        let sequenceInRound = 1;

        if (statements.length === 0) {
          // 第一个发言，选择第一个参与者
          nextDirector = participants[0];
        } else {
          const lastStatement = statements[0];
          const currentRoundStatements = statements.filter(s => s.round_number === roundNumber);
          
          if (currentRoundStatements.length >= participants.length) {
            // 当前轮已结束，开始新轮
            roundNumber++;
            sequenceInRound = 1;
            nextDirector = participants[0];
          } else {
            // 当前轮继续
            sequenceInRound = currentRoundStatements.length + 1;
            const nextParticipantIndex = currentRoundStatements.length % participants.length;
            nextDirector = participants[nextParticipantIndex];
          }
        }

        // 构建对话上下文
        const recentStatements = statements.slice(0, 5).reverse();
        const context = recentStatements.map(s => {
          const speaker = participants.find(p => p.director_id === s.director_id);
          return `${speaker?.name || 'Unknown'}: ${s.content}`;
        }).join('\n\n');

        // 调用Claude API生成发言
        const prompt = `你是${nextDirector.name}，${nextDirector.title}。

人设背景：${nextDirector.system_prompt}

会议话题：${meeting.topic}

之前的讨论：
${context || '（这是会议的开始）'}

请根据你的人设特点，针对当前话题发表你的观点。回应应该：
1. 体现你的历史背景和专业领域
2. 与之前的讨论内容相关
3. 保持你独特的说话风格
4. 长度控制在100-300字

请直接返回发言内容，不要包含任何格式标记。`;

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
        await env.DB.prepare(`
          INSERT INTO statements (id, meeting_id, director_id, content, round_number, 
                                sequence_in_round, tokens_used, claude_model, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          statementId, meetingId, nextDirector.director_id, statementContent,
          roundNumber, sequenceInRound, claudeData.usage?.output_tokens || 0,
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

        // 为每个发言添加Director对象
        const statementsWithDirector = statements.map(statement => ({
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